"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BasicPitch = void 0;
const tf = __importStar(require("@tensorflow/tfjs"));
const OUTPUT_TO_TENSOR_NAME = {
    contours: 'Identity',
    onsets: 'Identity_2',
    frames: 'Identity_1',
};
const NUM_CHANNELS = 1;
const AUDIO_SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const ANNOTATIONS_FPS = Math.floor(AUDIO_SAMPLE_RATE / FFT_HOP);
const AUDIO_WINDOW_LENGTH_SECONDS = 2;
const AUDIO_N_SAMPLES = AUDIO_SAMPLE_RATE * AUDIO_WINDOW_LENGTH_SECONDS - FFT_HOP;
const N_OVERLAPPING_FRAMES = 30;
const N_OVERLAP_OVER_2 = Math.floor(N_OVERLAPPING_FRAMES / 2);
const OVERLAP_LENGTH_FRAMES = N_OVERLAPPING_FRAMES * FFT_HOP;
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LENGTH_FRAMES;
class BasicPitch {
    constructor(modelOrModelPath) {
        if (OVERLAP_LENGTH_FRAMES % 2 !== 0) {
            throw new Error(`OVERLAP_LENGTH_FRAMES is not divisible by 2! Is ${OVERLAP_LENGTH_FRAMES}`);
        }
        this.model =
            typeof modelOrModelPath === 'string'
                ? tf.loadGraphModel(modelOrModelPath)
                : modelOrModelPath;
    }
    adjustNoteStart(notes, offsetSeconds) {
        return notes.map((note) => ({
            startTimeSeconds: note.startTimeSeconds + offsetSeconds,
            durationSeconds: note.durationSeconds,
            pitch_midi: note.pitchMidi,
            amplitude: note.amplitude,
            pitchBends: note.pitchBends,
        }));
    }
    async evaluateSingleFrame(reshapedInput, batchNumber) {
        const model = await this.model;
        const singleBatch = tf.slice(reshapedInput, batchNumber, 1);
        const results = model.execute(singleBatch, [
            OUTPUT_TO_TENSOR_NAME.frames,
            OUTPUT_TO_TENSOR_NAME.onsets,
            OUTPUT_TO_TENSOR_NAME.contours,
        ]);
        singleBatch.dispose();
        return [results[0], results[1], results[2]];
    }
    prepareData(singleChannelAudioData) {
        return tf.tidy(() => {
            const wavSamples = tf.concat1d([
                tf.zeros([Math.floor(OVERLAP_LENGTH_FRAMES / 2)], 'float32'),
                tf.tensor(singleChannelAudioData),
            ]);
            return [
                tf.expandDims(tf.signal.frame(wavSamples, AUDIO_N_SAMPLES, HOP_SIZE, true, 0), -1),
                singleChannelAudioData.length,
            ];
        });
    }
    unwrapOutput(result) {
        return tf.tidy(() => {
            let rawOutput = result;
            rawOutput = result.slice([0, N_OVERLAP_OVER_2, 0], [-1, result.shape[1] - 2 * N_OVERLAP_OVER_2, -1]);
            const outputShape = rawOutput.shape;
            return rawOutput.reshape([outputShape[0] * outputShape[1], outputShape[2]]);
        });
    }
    async evaluateModel(resampledBuffer, onComplete, percentCallback) {
        let singleChannelAudioData;
        if (resampledBuffer instanceof Float32Array) {
            singleChannelAudioData = resampledBuffer;
        }
        else {
            if (resampledBuffer.sampleRate !== AUDIO_SAMPLE_RATE) {
                throw new Error(`Input audio buffer is not at correct sample rate! ` +
                    `Is ${resampledBuffer.sampleRate}. Should be ${AUDIO_SAMPLE_RATE}`);
            }
            if (resampledBuffer.numberOfChannels !== NUM_CHANNELS) {
                throw new Error(`Input audio buffer is not mono! ` +
                    `Number of channels is ${resampledBuffer.numberOfChannels}. Should be ${NUM_CHANNELS}`);
            }
            singleChannelAudioData = resampledBuffer.getChannelData(0);
        }
        const [reshapedInput, audioOriginalLength] = this.prepareData(singleChannelAudioData);
        const nOutputFramesOriginal = Math.floor(audioOriginalLength * (ANNOTATIONS_FPS / AUDIO_SAMPLE_RATE));
        let calculatedFrames = 0;
        for (let i = 0; i < reshapedInput.shape[0]; ++i) {
            percentCallback(i / reshapedInput.shape[0]);
            const [resultingFrames, resultingOnsets, resultingContours] = await this.evaluateSingleFrame(reshapedInput, i);
            let unwrappedResultingFrames = this.unwrapOutput(resultingFrames);
            let unwrappedResultingOnsets = this.unwrapOutput(resultingOnsets);
            let unwrappedResultingContours = this.unwrapOutput(resultingContours);
            resultingFrames.dispose();
            resultingOnsets.dispose();
            resultingContours.dispose();
            const calculatedFramesTmp = unwrappedResultingFrames.shape[0];
            if (calculatedFrames >= nOutputFramesOriginal) {
                continue;
            }
            if (calculatedFramesTmp + calculatedFrames >= nOutputFramesOriginal) {
                const framesToOutput = nOutputFramesOriginal - calculatedFrames;
                let unwrappedResultingFramesSliced = unwrappedResultingFrames.slice([0, 0], [framesToOutput, -1]);
                unwrappedResultingFrames.dispose();
                unwrappedResultingFrames = unwrappedResultingFramesSliced;
                let unwrappedResultingOnsetsSliced = unwrappedResultingOnsets.slice([0, 0], [framesToOutput, -1]);
                unwrappedResultingOnsets.dispose();
                unwrappedResultingOnsets = unwrappedResultingOnsetsSliced;
                let unwrappedResultingContoursSliced = unwrappedResultingContours.slice([0, 0], [framesToOutput, -1]);
                unwrappedResultingContours.dispose();
                unwrappedResultingContours = unwrappedResultingContoursSliced;
            }
            calculatedFrames += calculatedFramesTmp;
            onComplete(await unwrappedResultingFrames.array(), await unwrappedResultingOnsets.array(), await unwrappedResultingContours.array());
            unwrappedResultingFrames.dispose();
            unwrappedResultingOnsets.dispose();
            unwrappedResultingContours.dispose();
        }
        reshapedInput.dispose();
        percentCallback(1.0);
    }
}
exports.BasicPitch = BasicPitch;
//# sourceMappingURL=inference.js.map