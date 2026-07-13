import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const INPUT_PATH = "/input/tasks.json";
const OUTPUT_DIRECTORY = "/output";
const OUTPUT_TEMP_PATH = join(OUTPUT_DIRECTORY, "results.tmp.json");
const OUTPUT_PATH = join(OUTPUT_DIRECTORY, "results.json");
const CAPTION_API_URL =
  "https://captionforge-ai-omega.vercel.app/api/captions";

const MAX_CONCURRENT_TASKS = 2;
const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 15_000;
const CAPTION_API_TIMEOUT_MS = 20_000;
const CAPTION_RETRY_DELAY_MS = 300;
const PER_TASK_TIMEOUT_MS = 40_000;
const GLOBAL_DEADLINE_MS = 8 * 60_000 + 30_000;
const OUTPUT_RESERVE_MS = 15_000;
const GLOBAL_WORK_CUTOFF_MS = GLOBAL_DEADLINE_MS - OUTPUT_RESERVE_MS;
const FRAME_COUNT = 5;
const MAX_FRAME_DATA_URL_CHARS = 790_000;
const MAX_TOTAL_FRAME_CHARS = 2_450_000;
const SUPPORTED_STYLES = [
  "formal",
  "sarcastic",
  "humorous_tech",
  "humorous_non_tech",
];
const SUPPORTED_STYLE_SET = new Set(SUPPORTED_STYLES);
const API_RESPONSE_KEYS = {
  formal: "formal",
  sarcastic: "sarcastic",
  humorous_tech: "humorousTech",
  humorous_non_tech: "humorousNonTech",
};
const SAFE_FALLBACK_CAPTIONS = {
  formal:
    "Caption generation was unavailable; please review this video before publishing.",
  sarcastic:
    "The caption service missed its cue, so human review gets the spotlight.",
  humorous_tech:
    "The caption pipeline timed out gracefully; manual review is now the most reliable feature.",
  humorous_non_tech:
    "The automatic caption took a break, so this clip is waiting for a human touch.",
};

class RetryableHttpError extends Error {}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function signalError(signal, fallbackMessage) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  return new Error(fallbackMessage);
}

function createLinkedTimeout(parentSignal, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(signalError(parentSignal, "Operation cancelled."));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  timer.unref();

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function abortableDelay(delayMs, signal) {
  if (signal?.aborted) {
    throw signalError(signal, "Delay cancelled.");
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalError(signal, "Delay cancelled."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runCommand(command, args, timeoutMs, signal) {
  if (signal?.aborted) {
    throw signalError(signal, `${command} cancelled.`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, closeSignal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (aborted) {
        reject(signalError(signal, `${command} cancelled.`));
        return;
      }

      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        const detail =
          stderr.trim() || `terminated by ${closeSignal || "unknown"}`;
        reject(new Error(`${command} exited with code ${code}: ${detail}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function normalizeVideoFileName(videoUrl) {
  const url = new URL(videoUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("video_url must use HTTP or HTTPS.");
  }

  let decodedName = "clip.mp4";

  try {
    decodedName = decodeURIComponent(basename(url.pathname)) || "clip.mp4";
  } catch {
    decodedName = basename(url.pathname) || "clip.mp4";
  }

  const safeName = decodedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return safeName || "clip.mp4";
}

async function probeDuration(videoUrl, signal) {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-rw_timeout",
      "8000000",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoUrl,
    ],
    FFPROBE_TIMEOUT_MS,
    signal,
  );
  const duration = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe did not return a valid positive duration.");
  }

  return duration;
}

async function extractRepresentativeFrames(
  videoUrl,
  tempDirectory,
  duration,
  signal,
) {
  const sampleStart = duration * 0.1;
  const sampleDuration = duration * 0.8;
  const frameRate = FRAME_COUNT / sampleDuration;
  const outputPattern = join(tempDirectory, "frame-%02d.jpg");

  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      sampleStart.toFixed(3),
      "-rw_timeout",
      "12000000",
      "-i",
      videoUrl,
      "-t",
      sampleDuration.toFixed(3),
      "-an",
      "-vf",
      `fps=${frameRate.toFixed(8)},scale='min(512,iw)':-2`,
      "-frames:v",
      String(FRAME_COUNT),
      "-q:v",
      "8",
      "-threads",
      "1",
      "-start_number",
      "1",
      outputPattern,
    ],
    FFMPEG_TIMEOUT_MS,
    signal,
  );

  const framePaths = Array.from({ length: FRAME_COUNT }, (_, index) =>
    join(tempDirectory, `frame-${String(index + 1).padStart(2, "0")}.jpg`),
  );
  const images = await Promise.all(framePaths.map((path) => readFile(path)));
  const interval = sampleDuration / FRAME_COUNT;
  const frames = images.map((image, index) => ({
    dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
    timestamp:
      Math.round((sampleStart + interval * (index + 0.5)) * 10) / 10,
  }));
  const totalChars = frames.reduce(
    (total, frame) => total + frame.dataUrl.length,
    0,
  );

  if (
    frames.some((frame) => frame.dataUrl.length > MAX_FRAME_DATA_URL_CHARS) ||
    totalChars >= MAX_TOTAL_FRAME_CHARS
  ) {
    throw new Error("Five compressed frames exceed the caption API limits.");
  }

  return frames;
}

function requestedStyles(task) {
  if (!task || typeof task !== "object" || !Array.isArray(task.styles)) {
    return [];
  }

  return [...new Set(task.styles.filter((style) => SUPPORTED_STYLE_SET.has(style)))];
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Task must be a JSON object.");
  }

  if (typeof task.task_id !== "string" || !task.task_id.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }

  if (typeof task.video_url !== "string" || !task.video_url.trim()) {
    throw new Error("video_url must be a non-empty string.");
  }

  if (!Array.isArray(task.styles) || task.styles.length === 0) {
    throw new Error("styles must be a non-empty array.");
  }

  const unsupportedStyles = task.styles.filter(
    (style) => !SUPPORTED_STYLE_SET.has(style),
  );

  if (unsupportedStyles.length > 0) {
    throw new Error(`Unsupported caption style: ${String(unsupportedStyles[0])}`);
  }

  return {
    taskId: task.task_id,
    videoUrl: task.video_url,
    styles: [...new Set(task.styles)],
  };
}

function preservedTaskId(task, index) {
  return task && typeof task === "object" && "task_id" in task
    ? task.task_id
    : `task-${index + 1}`;
}

function selectCaptions(styles, captions) {
  return Object.fromEntries(styles.map((style) => [style, captions[style]]));
}

function fallbackResult(task, index) {
  return {
    task_id: preservedTaskId(task, index),
    captions: selectCaptions(requestedStyles(task), SAFE_FALLBACK_CAPTIONS),
  };
}

function mapApiCaptions(styles, response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Caption API returned an invalid JSON object.");
  }

  const captions = {};

  for (const style of styles) {
    const responseKey = API_RESPONSE_KEYS[style];
    const caption = response[responseKey];

    if (typeof caption !== "string" || !caption.trim()) {
      throw new Error(`Caption API response is missing ${responseKey}.`);
    }

    captions[style] = caption.trim();
  }

  return captions;
}

async function makeCaptionRequest(requestBody, styles, taskSignal) {
  const timeout = createLinkedTimeout(
    taskSignal,
    CAPTION_API_TIMEOUT_MS,
    `Caption API timed out after ${CAPTION_API_TIMEOUT_MS}ms.`,
  );

  try {
    const response = await fetch(CAPTION_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      signal: timeout.signal,
    });
    const responseText = await response.text();

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHttpError(
        `Caption API returned HTTP ${response.status}: ${responseText.slice(0, 300)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Caption API returned HTTP ${response.status}: ${responseText.slice(0, 300)}`,
      );
    }

    let responseBody;

    try {
      responseBody = JSON.parse(responseText);
    } catch {
      throw new Error("Caption API returned invalid JSON.");
    }

    return mapApiCaptions(styles, responseBody);
  } catch (error) {
    if (timeout.signal.aborted) {
      throw signalError(timeout.signal, "Caption API request cancelled.");
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

async function requestCaptions(payload, styles, taskSignal) {
  const requestBody = JSON.stringify(payload);

  try {
    return await makeCaptionRequest(requestBody, styles, taskSignal);
  } catch (error) {
    if (!(error instanceof RetryableHttpError)) {
      throw error;
    }

    console.warn(
      `Caption API returned a retryable status; retrying once: ${errorMessage(error)}`,
    );
    await abortableDelay(CAPTION_RETRY_DELAY_MS, taskSignal);
    return makeCaptionRequest(requestBody, styles, taskSignal);
  }
}

async function processTask(rawTask, index, globalSignal) {
  if (globalSignal.aborted) {
    return fallbackResult(rawTask, index);
  }

  const taskTimeout = createLinkedTimeout(
    globalSignal,
    PER_TASK_TIMEOUT_MS,
    `Task timed out after ${PER_TASK_TIMEOUT_MS}ms.`,
  );
  let tempDirectory;

  try {
    const task = validateTask(rawTask);
    const videoFileName = normalizeVideoFileName(task.videoUrl);
    tempDirectory = await mkdtemp(join(tmpdir(), "captionforge-judge-"));

    console.log(`[${task.taskId}] Probing remote video.`);
    const duration = await probeDuration(task.videoUrl, taskTimeout.signal);
    const frames = await extractRepresentativeFrames(
      task.videoUrl,
      tempDirectory,
      duration,
      taskTimeout.signal,
    );
    const captions = await requestCaptions(
      {
        frames,
        context: "",
        videoFileName,
        videoDuration: Math.round(duration * 10) / 10,
      },
      task.styles,
      taskTimeout.signal,
    );

    console.log(`[${task.taskId}] Completed.`);
    return { task_id: task.taskId, captions };
  } catch (error) {
    console.error(
      `[${String(preservedTaskId(rawTask, index))}] Task failed: ${errorMessage(error)}`,
    );
    return fallbackResult(rawTask, index);
  } finally {
    taskTimeout.clear();

    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true }).catch((error) => {
        console.warn(`Temporary file cleanup failed: ${errorMessage(error)}`);
      });
    }
  }
}

async function processTasksInto(tasks, results, globalSignal) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = globalSignal.aborted
        ? fallbackResult(tasks[index], index)
        : await processTask(tasks[index], index, globalSignal);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_TASKS, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function writeResults(results) {
  try {
    await writeFile(OUTPUT_TEMP_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    await rename(OUTPUT_TEMP_PATH, OUTPUT_PATH);
  } catch (error) {
    throw new Error(`Unable to write results: ${errorMessage(error)}`);
  }
}

async function main() {
  const runStartedAt = Date.now();
  let tasks;

  try {
    const rawInput = await readFile(INPUT_PATH, "utf8");
    tasks = JSON.parse(rawInput);

    if (!Array.isArray(tasks)) {
      throw new Error("/input/tasks.json must contain a JSON array.");
    }
  } catch (error) {
    throw new Error(`Unable to read tasks: ${errorMessage(error)}`);
  }

  try {
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  } catch (error) {
    throw new Error(`Unable to create output directory: ${errorMessage(error)}`);
  }

  const results = new Array(tasks.length);
  const globalController = new AbortController();
  const processing = processTasksInto(tasks, results, globalController.signal);
  const cutoffDelay = Math.max(
    0,
    GLOBAL_WORK_CUTOFF_MS - (Date.now() - runStartedAt),
  );
  let cutoffTimer;
  const cutoff = new Promise((resolve) => {
    cutoffTimer = setTimeout(() => {
      console.warn(
        "Global deadline is close; cancelling unfinished tasks and writing fallbacks.",
      );
      globalController.abort(new Error("Global judging deadline reached."));
      resolve("deadline");
    }, cutoffDelay);
  });
  const processingOutcome = processing
    .then(() => "complete")
    .catch((error) => {
      console.error(`Unexpected processing failure: ${errorMessage(error)}`);
      globalController.abort(error);
      return "processing-error";
    });
  const outcome = await Promise.race([processingOutcome, cutoff]);

  if (outcome !== "deadline") {
    clearTimeout(cutoffTimer);
  }

  const finalResults = results.map(
    (result, index) => result || fallbackResult(tasks[index], index),
  );
  await writeResults(finalResults);
  console.log(`Wrote ${finalResults.length} result(s) to ${OUTPUT_PATH}.`);

  if (outcome !== "complete") {
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
