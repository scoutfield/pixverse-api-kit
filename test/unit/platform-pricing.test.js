import assert from "node:assert/strict";
import test from "node:test";

import { getPlatformOperation } from "../../src/platform/operations.js";
import {
  creditsToUsd,
  estimatePlatformCost,
  finalJobCost,
  formatPlatformCost,
  platformCallCost,
} from "../../src/platform/pricing.js";
import { normalizeAndValidatePlatformInput } from "../../src/platform/validation.js";

const op = (id) => getPlatformOperation(id);

test("estimates reproduce the official pricing-page calculation examples", () => {
  assert.equal(estimatePlatformCost(op("video.text"), { model: "c1", quality: "1080p", duration: 5 }).credits, 95);
  assert.equal(estimatePlatformCost(op("video.text"), {
    model: "v6", quality: "720p", duration: 8, generate_audio_switch: true,
  }).credits, 96);
  assert.equal(estimatePlatformCost(op("video.image"), {
    model: "v5.6", quality: "720p", duration: 8, generate_audio_switch: true,
  }).credits, 135);
  assert.equal(creditsToUsd(95), 0.422);
  assert.equal(creditsToUsd(135), 0.6);
});

test("V6 Max uses its own per-second rates", () => {
  const cost = estimatePlatformCost(op("video.text"), { model: "v6-max", quality: "1080p", duration: 10, generate_audio_switch: true });
  assert.equal(cost.credits, 280);
  assert.equal(cost.usd, 1.244);
  assert.equal(cost.source, "estimate");
});

test("unsupported fixed tiers and length-dependent operations report rates without totals", () => {
  assert.equal(estimatePlatformCost(op("video.text"), { model: "v5.6", quality: "1080p", duration: 10 }).credits, null);
  const expand = estimatePlatformCost(op("video.expand"), { source_video_id: "1", aspect_ratio: "16:9", quality: "1080p" });
  assert.equal(expand.credits, null);
  assert.equal(expand.credits_per_source_second, 24);
  assert.equal(estimatePlatformCost(op("video.swap-mask"), {}).credits, 2);
});

test("speech estimates count TTS units in 15 UTF-8 byte blocks", () => {
  const content = "a".repeat(31);
  assert.equal(estimatePlatformCost(op("video.avatar"), { quality: "720p", lip_sync_tts_content: content }).credits, 3 * 15);
  assert.equal(estimatePlatformCost(op("video.lip-sync"), { lip_sync_tts_content: content }).credits, 3 * 4);
});

test("multi-transition sums segment tiers and doubles fast mode", () => {
  const payload = { quality: "720p", multi_transition: [{ duration: 5 }, { duration: 3 }, {}] };
  assert.equal(estimatePlatformCost(op("video.multi-transition"), payload).credits, 102);
  assert.equal(estimatePlatformCost(op("video.multi-transition"), { ...payload, motion_mode: "fast" }).credits, 204);
});

test("provider-reported credits supersede estimates and status credits are final", () => {
  const created = platformCallCost(op("video.text"), {
    payload: { model: "v6", quality: "720p", duration: 5 },
    data: { video_id: "1", credits: 50 },
  });
  assert.equal(created.credits, 50);
  assert.equal(created.source, "response");
  assert.equal(created.estimate.credits, 45);
  const final = finalJobCost(created, { status: 1, credits: 45 });
  assert.equal(final.credits, 45);
  assert.equal(final.source, "status");
  assert.equal(final.submitted.credits, 50);
});

test("non-billable calls cost zero and status reads expose the task cost", () => {
  assert.deepEqual(platformCallCost(op("account.balance"), {}), { credits: 0, usd: 0, source: "non-billable" });
  const status = platformCallCost(op("video.status"), { data: { id: "1", credits: 96 } });
  assert.equal(status.credits, 0);
  assert.equal(status.task_credits, 96);
  assert.equal(formatPlatformCost(status), "Cost: $0 for this call (task cost 96 credits ≈ $0.427)");
});

test("V6 Max is limited to text-to-video and image-to-video, up to 15 seconds", async () => {
  await normalizeAndValidatePlatformInput(op("video.text"), {
    payload: { model: "v6-max", prompt: "A marble rolls.", duration: 15, quality: "720p", aspect_ratio: "21:9" },
  });
  await assert.rejects(normalizeAndValidatePlatformInput(op("video.text"), {
    payload: { model: "v6-max", prompt: "A marble rolls.", duration: 16, quality: "720p", aspect_ratio: "16:9" },
  }), /duration/);
  await assert.rejects(normalizeAndValidatePlatformInput(op("video.transition"), {
    payload: { model: "v6-max", prompt: "Morph.", duration: 5, quality: "720p", first_frame_img: "1", last_frame_img: "2" },
  }), /v6-max supports only/);
});

test("video expand requires one source, a supported aspect ratio, and 720p or 1080p", async () => {
  await normalizeAndValidatePlatformInput(op("video.expand"), {
    payload: { video_media_id: "3", aspect_ratio: "9:16", quality: "1080p" },
  });
  await assert.rejects(normalizeAndValidatePlatformInput(op("video.expand"), {
    payload: { source_video_id: "1", video_media_id: "3", aspect_ratio: "9:16", quality: "720p" },
  }));
  await assert.rejects(normalizeAndValidatePlatformInput(op("video.expand"), {
    payload: { source_video_id: "1", aspect_ratio: "2:3", quality: "720p" },
  }), /aspect_ratio/);
  await assert.rejects(normalizeAndValidatePlatformInput(op("video.expand"), {
    payload: { source_video_id: "1", aspect_ratio: "16:9", quality: "540p" },
  }), /quality/);
});
