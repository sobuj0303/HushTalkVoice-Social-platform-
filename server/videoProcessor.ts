import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VideoProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeBytes: number;
}

export interface VideoCompressionResult {
  filePath: string;
  filename: string;
  sizeBytes: number;
  originalSizeBytes: number;
  compressed: boolean;
}

export async function probeVideoFile(filePath: string): Promise<VideoProbeInfo> {
  const sizeBytes = fs.statSync(filePath).size;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 30_000 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams: any[] = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    const rawDuration = Number(parsed.format?.duration || videoStream?.duration || 0);

    return {
      duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 10,
      width: Number(videoStream?.width || 1280),
      height: Number(videoStream?.height || 720),
      hasAudio: Boolean(audioStream),
      sizeBytes,
    };
  } catch {
    return {
      duration: 10,
      width: 1280,
      height: 720,
      hasAudio: true,
      sizeBytes,
    };
  }
}

const AUTO_COMPRESS_THRESHOLD_BYTES = 2.5 * 1024 * 1024; // Auto-optimize videos larger than 2.5 MB for fast sharing
const FAST_SHARE_CAP_BYTES = 15 * 1024 * 1024; // Target ~13-15 MB sweet spot for larger videos when possible

function chooseOptimalHeight(videoBps: number, sourceHeight: number, originalSizeBytes = 0): number {
  const safeSrc = sourceHeight > 0 ? sourceHeight : 720;
  let cap = 1080;
  if (videoBps < 280_000) cap = 360;
  else if (videoBps < 650_000) cap = 480;
  else if (videoBps < 2_400_000 || originalSizeBytes > 12 * 1024 * 1024) cap = 720;
  return Math.min(safeSrc, cap);
}

async function runTranscodePass(
  inputPath: string,
  outputPath: string,
  options: {
    videoBps: number;
    audioBps: number;
    hasAudio: boolean;
    maxHeight: number;
    crf: number;
    preset: string;
    forceBitrate?: boolean;
  }
): Promise<void> {
  const scaleFilter = `scale='trunc(iw*min(1\\,${options.maxHeight}/ih)/2)*2':'trunc(ih*min(1\\,${options.maxHeight}/ih)/2)*2'`;

  const args: string[] = [
    '-y',
    '-i',
    inputPath,
    '-vf',
    scaleFilter,
    '-c:v',
    'libx264',
    '-preset',
    options.preset,
  ];

  if (options.forceBitrate) {
    args.push(
      '-b:v',
      String(options.videoBps),
      '-maxrate',
      String(Math.round(options.videoBps * 1.1)),
      '-bufsize',
      String(options.videoBps * 2)
    );
  } else {
    args.push(
      '-crf',
      String(options.crf),
      '-maxrate',
      String(options.videoBps),
      '-bufsize',
      String(options.videoBps * 2)
    );
  }

  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart');

  if (options.hasAudio && options.audioBps > 0) {
    args.push('-c:a', 'aac', '-b:a', String(options.audioBps), '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push(outputPath);

  await execFileAsync('ffmpeg', args, { timeout: 240_000 });
}

/**
 * Automatically compresses/transcodes uploaded videos:
 * - Any video above `maxBytes` is strictly compressed beneath `maxBytes`.
 * - Any larger video (>2.5 MB) is automatically optimized/resized (~65-72% of original, targeting ~13-15 MB for 20+ MB uploads)
 *   for fast sharing without changing core playback compatibility.
 */
export async function compressVideoUnderLimit(
  inputPath: string,
  maxBytes: number = 50 * 1024 * 1024
): Promise<VideoCompressionResult> {
  const originalSizeBytes = fs.statSync(inputPath).size;
  const filename = path.basename(inputPath);

  // Small clips already within fast-share threshold and max limit stay untouched
  if (originalSizeBytes <= maxBytes && originalSizeBytes <= AUTO_COMPRESS_THRESHOLD_BYTES) {
    return {
      filePath: inputPath,
      filename,
      sizeBytes: originalSizeBytes,
      originalSizeBytes,
      compressed: false,
    };
  }

  const probe = await probeVideoFile(inputPath);
  const duration = Math.max(1, probe.duration);

  const hardTargetBytes = Math.floor(maxBytes * 0.88);
  // Target ~68% of original size (capped around 15 MB for larger clips when bitrate stays healthy)
  const scaledShareBytes = Math.round(originalSizeBytes * 0.68);
  const fastShareBytes =
    originalSizeBytes > 16 * 1024 * 1024
      ? Math.min(hardTargetBytes, Math.max(13 * 1024 * 1024, Math.min(FAST_SHARE_CAP_BYTES, scaledShareBytes)))
      : Math.min(hardTargetBytes, scaledShareBytes);

  const audioBps = probe.hasAudio ? (duration > 900 ? 64_000 : 96_000) : 0;
  // Keep video bitrate healthy (>=360 kbps) for long clips unless hardTargetBytes demands lower
  const minHealthyTotalBytes = Math.min(
    hardTargetBytes,
    Math.ceil(((360_000 + audioBps) * duration) / 8)
  );
  const effectiveTargetBytes =
    originalSizeBytes > maxBytes
      ? fastShareBytes
      : Math.min(Math.floor(originalSizeBytes * 0.85), Math.max(fastShareBytes, minHealthyTotalBytes));

  const totalBitsBudget = effectiveTargetBytes * 8;
  const rawVideoBps = Math.floor(totalBitsBudget / duration) - audioBps;
  const videoBps = Math.max(140_000, Math.min(4_500_000, rawVideoBps));
  const maxHeight = chooseOptimalHeight(videoBps, probe.height, originalSizeBytes);

  const dir = path.dirname(inputPath);
  const baseNoExt = filename.replace(/\.[^.]+$/, '');
  const outFilename = `${baseNoExt}-opt.mp4`;
  const outPath = path.join(dir, outFilename);
  const tmpPath = path.join(dir, `${baseNoExt}.${Date.now()}.tmp.mp4`);

  try {
    await runTranscodePass(inputPath, tmpPath, {
      videoBps,
      audioBps,
      hasAudio: probe.hasAudio,
      maxHeight,
      crf: originalSizeBytes > 10 * 1024 * 1024 ? 25 : 23,
      preset: 'fast',
    });

    let compressedSize = fs.statSync(tmpPath).size;

    // Fallback tighter pass if output still exceeds maxBytes OR failed to meaningfully shrink a large video
    const needsTighterPass =
      compressedSize > maxBytes ||
      (originalSizeBytes > 8 * 1024 * 1024 && compressedSize > Math.min(maxBytes, Math.round(originalSizeBytes * 0.82)));

    if (needsTighterPass) {
      const tighterVideoBps = Math.max(120_000, Math.floor(videoBps * 0.78));
      const tighterHeight = Math.min(maxHeight, originalSizeBytes > maxBytes ? 480 : 720);
      const tmpPath2 = path.join(dir, `${baseNoExt}.${Date.now()}.p2.mp4`);
      await runTranscodePass(inputPath, tmpPath2, {
        videoBps: tighterVideoBps,
        audioBps: probe.hasAudio ? 64_000 : 0,
        hasAudio: probe.hasAudio,
        maxHeight: tighterHeight,
        crf: 26,
        preset: 'veryfast',
        forceBitrate: true,
      });
      const secondSize = fs.statSync(tmpPath2).size;
      if (secondSize < compressedSize) {
        fs.unlinkSync(tmpPath);
        fs.renameSync(tmpPath2, outPath);
        compressedSize = secondSize;
      } else {
        fs.unlinkSync(tmpPath2);
        fs.renameSync(tmpPath, outPath);
      }
    } else {
      fs.renameSync(tmpPath, outPath);
    }

    if (compressedSize > maxBytes) {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      throw new Error('Could not process this video. Please try a shorter clip.');
    }

    // If source was already within maxBytes and compression didn't reduce size, keep the smaller original
    if (originalSizeBytes <= maxBytes && compressedSize >= originalSizeBytes) {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      return {
        filePath: inputPath,
        filename,
        sizeBytes: originalSizeBytes,
        originalSizeBytes,
        compressed: false,
      };
    }

    // Remove the raw upload so only the optimized video remains on disk
    if (fs.existsSync(inputPath) && inputPath !== outPath) {
      fs.unlink(inputPath, () => {});
    }

    return {
      filePath: outPath,
      filename: outFilename,
      sizeBytes: compressedSize,
      originalSizeBytes,
      compressed: true,
    };
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlink(tmpPath, () => {});
    if (fs.existsSync(outPath)) fs.unlink(outPath, () => {});
    throw err;
  }
}

export interface VideoThumbnailResult {
  filePath: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Captures a representative JPEG thumbnail frame from an uploaded video using ffmpeg.
 * Seeks ~18% into the clip (clamped 0.4s..4s) to avoid blank fade-in frames,
 * with an automatic 0s fallback for ultra-short clips.
 */
export async function generateVideoThumbnail(
  videoPath: string,
  outputDir?: string
): Promise<VideoThumbnailResult | null> {
  if (!fs.existsSync(videoPath)) return null;

  const targetDir = outputDir || path.join(path.dirname(videoPath), 'thumbs');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const probe = await probeVideoFile(videoPath);
  const preferredSeek =
    probe.duration >= 1.2 ? Math.min(4.0, Math.max(0.4, Number((probe.duration * 0.18).toFixed(2)))) : 0;

  const baseName = path.basename(videoPath).replace(/\.[^.]+$/, '');
  const thumbFilename = `${baseName}-thumb.jpg`;
  const thumbPath = path.join(targetDir, thumbFilename);

  const attemptCapture = async (seekSec: number): Promise<boolean> => {
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(seekSec),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(960,iw)':-2",
          '-q:v',
          '3',
          thumbPath,
        ],
        { timeout: 30_000 }
      );
      return fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
    } catch {
      return false;
    }
  };

  let ok = await attemptCapture(preferredSeek);
  if (!ok && preferredSeek > 0) {
    ok = await attemptCapture(0);
  }

  if (!ok) {
    if (fs.existsSync(thumbPath)) fs.unlink(thumbPath, () => {});
    return null;
  }

  return {
    filePath: thumbPath,
    filename: thumbFilename,
    sizeBytes: fs.statSync(thumbPath).size,
  };
}

