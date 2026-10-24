import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { getPlatformOperation, PLATFORM_OPERATIONS } from "../../src/platform/operations.js";
import { normalizeAndValidatePlatformInput } from "../../src/platform/validation.js";

const invalidById = Object.freeze({
  "account.balance": null,
  "account.usage": { start_time: "2026-09-20 00:00:00", end_time: "2026-09-18 00:00:00" },
  "upload.image": {},
  "upload.media": { file: "a", file_url: "https://example.com/a.mp4" },
  "audio.verify": {},
  "resource.templates": null,
  "resource.tts-speakers": null,
  "resource.restyle-effects": {},
  "voice.create": {},
  "voice.delete": { speaker_id: Number.MAX_SAFE_INTEGER + 1 },
  "image.template": {},
  "image.status": { image_id: Number.MAX_SAFE_INTEGER + 1 },
  "video.text": {},
  "video.image": {},
  "video.template": {},
  "video.transition": {},
  "video.multi-transition": { multi_transition: [{ img_id: "1" }] },
  "video.lip-sync": {},
  "video.fusion": { image_references: [] },
  "video.restyle": {},
  "video.swap-mask": {},
  "video.swap": {},
  "video.sound-effect": {},
  "video.extend": {},
  "video.motion-control": {},
  "video.modify": {},
  "video.upscale": {},
  "video.expand": {},
  "video.avatar": {},
  "agent.viral-recreation": {},
  "agent.real-estate": {},
  "agent.music-mv": {},
  "video.status": { video_id: Number.MAX_SAFE_INTEGER + 1 },
});

test("the RED table independently covers every Platform operation ID", () => {
  assert.deepEqual(Object.keys(invalidById).sort(), PLATFORM_OPERATIONS.map(({ id }) => id).sort());
});

for (const operation of PLATFORM_OPERATIONS) {
  test(`${operation.id} rejects its minimal invalid input before fetch`, async () => {
    const context = {
      fetchCalls: [],
      inspectLocalMedia: async () => {
        throw new Error("media inspection must not run for a structurally invalid request");
      },
    };
    await assert.rejects(
      normalizeAndValidatePlatformInput(operation, invalidById[operation.id], context),
      /input|required|provide|safe integer|string|start|source|reference|item|page/i,
    );
    assert.equal(context.fetchCalls.length, 0);
  });
}

test("normalization preserves unknown official fields and never mutates deeply frozen input", async () => {
  const input = Object.freeze({
    prompt: "A paper boat crosses a puddle.",
    model: "v6",
    quality: "720p",
    duration: 5,
    aspect_ratio: "16:9",
    seed: 42,
    newly_released_option: Object.freeze({ enabled: true }),
  });

  const result = await normalizeAndValidatePlatformInput(getPlatformOperation("video.text"), input);

  assert.deepEqual(result.payload, input);
  assert.notEqual(result.payload, input);
  assert.notEqual(result.payload.newly_released_option, input.newly_released_option);
  assert.deepEqual(result.query, {});
  assert.deepEqual(result.pathParams, {});
  assert.deepEqual(result.files, {});
  assert.equal(result.validationSummary.operation, "video.text");
});

test("unsafe numeric identifiers are rejected instead of being rounded", async () => {
  await assert.rejects(
    normalizeAndValidatePlatformInput(getPlatformOperation("video.status"), {
      video_id: 627410861853514292,
    }),
    /video_id.*string/i,
  );
  const result = await normalizeAndValidatePlatformInput(getPlatformOperation("video.status"), {
    video_id: 42,
  });
  assert.equal(result.pathParams.video_id, "42");
});

test("upload inputs require exactly one endpoint-specific local file or safe remote URL", async () => {
  const image = getPlatformOperation("upload.image");
  const media = getPlatformOperation("upload.media");
  await assert.rejects(normalizeAndValidatePlatformInput(image, {}), /exactly one.*image.*image_url/i);
  await assert.rejects(normalizeAndValidatePlatformInput(image, {
    image: "/tmp/a.png",
    image_url: "https://cdn.example.com/a.png",
  }), /exactly one.*image.*image_url/i);
  await assert.rejects(normalizeAndValidatePlatformInput(media, {
    file_url: "file:///etc/passwd",
  }), /http|url/i);
  await assert.rejects(normalizeAndValidatePlatformInput(image, {
    image_url: "https://user:password@example.com/a.png",
  }), /credentials|url/i);
  for (const image_url of [
    "http://[::ffff:127.0.0.1]/a.png",
    "http://[::ffff:10.0.0.1]/a.png",
    "http://[fe80::1]/a.png",
    "http://[fd00::1]/a.png",
  ]) {
    await assert.rejects(normalizeAndValidatePlatformInput(image, { image_url }), /local|private/i);
  }
});

test("image uploads enforce published extension, size, and dimension limits through injected inspection", async () => {
  const operation = getPlatformOperation("upload.image");
  const calls = [];
  const valid = await normalizeAndValidatePlatformInput(operation, { image: "/safe/tiny.png", tag: "kept" }, {
    inspectLocalMedia: async (file, options) => {
      calls.push({ file, options });
      return { size_bytes: 100, width: 1, height: 1, streams: [] };
    },
  });
  assert.deepEqual(valid.files, { image: "/safe/tiny.png" });
  assert.deepEqual(valid.payload, { tag: "kept" });
  assert.deepEqual(calls, [{
    file: "/safe/tiny.png",
    options: {
      allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
      maxBytes: 20 * 1024 * 1024 - 1,
    },
  }]);

  for (const metadata of [
    { size_bytes: 20 * 1024 * 1024 + 1, width: 1, height: 1 },
    { size_bytes: 100, width: 10_001, height: 1 },
    { size_bytes: 100, width: 1, height: 10_001 },
  ]) {
    await assert.rejects(normalizeAndValidatePlatformInput(operation, { image: "/safe/tiny.png" }, {
      inspectLocalMedia: async () => metadata,
    }), /20 MB|10,?000|size|dimension/i);
  }
});

test("local media uploads enforce official type and video-dimension policy without invented universal limits", async () => {
  const operation = getPlatformOperation("upload.media");
  const calls = [];
  const result = await normalizeAndValidatePlatformInput(operation, { file: "/safe/tiny.mp4" }, {
    inspectLocalMedia: async (file, options) => {
      calls.push({ file, options });
      return {
        size_bytes: 500 * 1024 * 1024,
        duration_seconds: 600,
        width: 1920,
        height: 1080,
        streams: [{ codec_type: "video" }],
      };
    },
  });
  assert.deepEqual(result.files, { file: "/safe/tiny.mp4" });
  assert.deepEqual(calls[0].options, {
    allowedExtensions: [".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".aac"],
  });

  await assert.rejects(normalizeAndValidatePlatformInput(operation, { file: "/safe/payload.exe" }, {
    inspectLocalMedia: async () => assert.fail("unsupported media must fail before inspection"),
  }), /extension|media type/i);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, { file: "/safe/wide.mp4" }, {
    inspectLocalMedia: async () => ({ width: 1921, height: 1080, streams: [{ codec_type: "video" }] }),
  }), /1,?920|dimension/i);
});

test("usage timestamps reject impossible UTC calendar dates", async () => {
  await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("account.usage"), {
    start_time: "2026-02-30 00:00:00",
    end_time: "2026-03-01 00:00:00",
  }), /start_time/i);
});

test("transition, fusion, voice, swap, source-video, and agent inputs enforce their identifier combinations", async () => {
  const cases = [
    ["video.transition", {
      first_frame_img: "1", prompt: "move", model: "v6", duration: 5, quality: "720p",
    }, /last.*frame/i],
    ["video.multi-transition", {
      model: "v5", quality: "720p", multi_transition: [{ img_id: "1" }],
    }, /item|transition/i],
    ["video.fusion", {
      prompt: "combine", image_references: [], model: "v6", duration: 5,
      quality: "720p", aspect_ratio: "16:9",
    }, /reference|image/i],
    ["video.lip-sync", { source_video_id: "1" }, /audio|speaker|tts/i],
    ["video.swap-mask", { keyframe_id: 1 }, /source/i],
    ["video.restyle", { restyle_id: "1" }, /source/i],
    ["agent.viral-recreation", { agent_id: "414562414124109", prompt: "remake" }, /reference/i],
    ["agent.real-estate", { agent_id: "419629433597950" }, /model/i],
  ];
  for (const [id, input, pattern] of cases) {
    await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation(id), input), pattern);
  }
});

test("audio verification requires a positive decimal media ID", async () => {
  const operation = getPlatformOperation("audio.verify");
  const accepted = await normalizeAndValidatePlatformInput(operation, { audio_media_id: 42 });
  assert.deepEqual(accepted.payload, { audio_media_id: "42" });
  for (const audio_media_id of ["0", "-1", "not-an-id"]) {
    await assert.rejects(
      normalizeAndValidatePlatformInput(operation, { audio_media_id }),
      /audio_media_id.*positive decimal/i,
    );
  }
  await assert.rejects(
    normalizeAndValidatePlatformInput(operation, { audio_media_id: "18446744073709551616" }),
    /audio_media_id.*uint64/i,
  );
});

test("video upscale accepts exactly one validated Platform video source", async () => {
  const operation = getPlatformOperation("video.upscale");
  const uploaded = await normalizeAndValidatePlatformInput(operation, { video_media_id: 42 });
  assert.deepEqual(uploaded.payload, { video_media_id: "42" });
  const generated = await normalizeAndValidatePlatformInput(operation, { source_video_id: "43" });
  assert.deepEqual(generated.payload, { source_video_id: "43" });

  for (const video_media_id of ["0", "-1", "not-an-id", "18446744073709551616"]) {
    await assert.rejects(
      normalizeAndValidatePlatformInput(operation, { video_media_id }),
      /video_media_id.*positive decimal|video_media_id.*uint64/i,
    );
  }
  await assert.rejects(
    normalizeAndValidatePlatformInput(operation, {
      source_video_id: "43",
      video_media_id: "42",
    }),
    /exactly one.*source_video_id.*video_media_id/i,
  );
});

test("Music MV normalizes the documented image alias without mutating frozen input", async () => {
  const operation = getPlatformOperation("agent.music-mv");
  const reference = Object.freeze({ img_id: "164913710", ref_name: "Character Image" });
  const input = Object.freeze({
    mv_agent_type: "vibe_mv_v3_custom",
    audio_media_id: "405833376854443",
    image_references: Object.freeze([reference]),
    music_style: "pOp",
    mv_style: "cUsToM",
    aspect_ratio: "16:9",
    quality: "720p",
    caption_switch: true,
    lip_sync_switch: false,
    instrumental_switch: false,
    seed: 42,
  });

  const result = await normalizeAndValidatePlatformInput(operation, input);

  assert.equal(Object.hasOwn(result.payload, "image_references"), false);
  assert.deepEqual(result.payload.img_references, [{ img_id: "164913710", ref_name: "Character Image" }]);
  assert.equal(result.payload.music_style, "pOp");
  assert.equal(result.payload.mv_style, "cUsToM");
  assert.equal(Object.hasOwn(input, "img_references"), false);
  assert.equal(input.image_references[0], reference);
});

test("Music MV rejects ambiguous aliases, unsupported enums, invalid switches, seeds, and references", async () => {
  const operation = getPlatformOperation("agent.music-mv");
  const base = {
    mv_agent_type: "vibe_mv_v3_custom",
    audio_media_id: "405833376854443",
    img_references: [{ img_id: "164913710" }],
    mv_style: "Custom",
    aspect_ratio: "16:9",
    quality: "720p",
  };
  const cases = [
    [{ ...base, image_references: [{ img_id: "2" }] }, /only one.*img_references.*image_references/i],
    [{ ...base, mv_agent_type: "unknown" }, /mv_agent_type/i],
    [{ ...base, audio_media_id: "0" }, /audio_media_id.*positive decimal/i],
    [{ ...base, audio_media_id: "18446744073709551616" }, /audio_media_id.*uint64/i],
    [{ ...base, aspect_ratio: "21:9" }, /aspect_ratio/i],
    [{ ...base, quality: "4k" }, /quality/i],
    [{ ...base, music_style: "Opera" }, /music_style/i],
    [{ ...base, mv_style: "Neon Noir" }, /mv_style/i],
    [{ ...base, caption_switch: "true" }, /caption_switch.*boolean/i],
    [{ ...base, lip_sync_switch: 1 }, /lip_sync_switch.*boolean/i],
    [{ ...base, instrumental_switch: null }, /instrumental_switch.*boolean/i],
    [{ ...base, seed: -1 }, /seed/i],
    [{ ...base, img_references: [{ img_id: "1" }, { img_id: "2" }] }, /img_references.*no more than one/i],
    [{ ...base, img_references: [{ img_id: "0" }] }, /img_id.*positive decimal/i],
    [{ ...base, img_references: [{ img_id: "18446744073709551616" }] }, /img_id.*uint64/i],
    [{ ...base, img_references: [{ img_id: "1", ref_name: 7 }] }, /ref_name.*string/i],
    [{ ...base, img_references: [], style_img_references: [] }, /Custom.*reference/i],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(normalizeAndValidatePlatformInput(operation, input), pattern);
  }

  await assert.rejects(normalizeAndValidatePlatformInput(operation, { ...base, mv_agent_type: "vibe_mv" }), /mv_agent_type/);
  for (const mv_agent_type of ["vibe_mv_v3", "vibe_mv_v3_custom"]) {
    const result = await normalizeAndValidatePlatformInput(operation, { ...base, mv_agent_type });
    assert.equal(result.payload.mv_agent_type, mv_agent_type);
  }
});

test("Music MV validates plain and timestamped lyrics deterministically", async () => {
  const operation = getPlatformOperation("agent.music-mv");
  const base = {
    mv_agent_type: "vibe_mv_v3_custom",
    audio_media_id: "405833376854443",
    aspect_ratio: "9:16",
    quality: "1080p",
  };
  const accepted = await normalizeAndValidatePlatformInput(operation, {
    ...base,
    lyric_text: "Ignored when timestamps are present",
    lyric_timestamp: {
      words: [
        { start: 0, end: 0.32, word: "Who" },
        { start: 0.32, end: 0.64, word: "be" },
      ],
    },
  });
  assert.equal(accepted.payload.lyric_timestamp.words.length, 2);

  const invalid = [
    [{ ...base, lyric_text: "x".repeat(5000) }, /lyric_text.*5,?000/i],
    [{ ...base, lyric_timestamp: null }, /lyric_timestamp.*object/i],
    [{ ...base, lyric_timestamp: { words: [] } }, /words.*non-empty/i],
    [{ ...base, lyric_timestamp: { words: [{ start: -1, end: 0, word: "bad" }] } }, /start/i],
    [{ ...base, lyric_timestamp: { words: [{ start: 1, end: 0, word: "bad" }] } }, /end/i],
    [{ ...base, lyric_timestamp: { words: [{ start: 0, end: 1, word: "one" }, { start: 0.5, end: 2, word: "two" }] } }, /overlap|monotonic/i],
    [{ ...base, lyric_timestamp: { words: [{ start: 0, end: 1, word: "" }] } }, /word.*non-empty/i],
    [{ ...base, lyric_timestamp: { words: [{ start: Number.NaN, end: 1, word: "bad" }] } }, /finite/i],
  ];
  for (const [input, pattern] of invalid) {
    await assert.rejects(normalizeAndValidatePlatformInput(operation, input), pattern);
  }
});

const distinguishingFieldCases = [
  ["video.template", {
    template_id: "template-1",
    img_id: "1",
    prompt: "Animate naturally",
    model: "v6",
    duration: 5,
    quality: "720p",
  }, "template_id"],
  ["video.sound-effect", {
    source_video_id: "1",
    sound_effect_content: "Soft rain and distant thunder",
  }, "source_video_id"],
];

for (const [id, validInput, distinguishingField] of distinguishingFieldCases) {
  test(`${id} requires its distinguishing ${distinguishingField} field`, async () => {
    await normalizeAndValidatePlatformInput(getPlatformOperation(id), validInput);
    const { [distinguishingField]: omitted, ...mutatedInput } = validInput;
    assert.notEqual(omitted, undefined);
    await assert.rejects(
      normalizeAndValidatePlatformInput(getPlatformOperation(id), mutatedInput),
      new RegExp(distinguishingField, "i"),
    );
  });
}

test("video.modify validates the documented mask_urls field and enforces its three-item maximum", async () => {
  const operation = getPlatformOperation("video.modify");
  const base = {
    source_video_id: "1",
    prompt: "Replace the foreground subject",
    quality: "720p",
  };

  const accepted = await normalizeAndValidatePlatformInput(operation, {
    ...base,
    mask_urls: [
      "https://cdn.example.com/mask-1.png",
      "https://cdn.example.com/mask-2.png",
      "https://cdn.example.com/mask-3.png",
    ],
  });
  assert.equal(accepted.payload.mask_urls.length, 3);

  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    mask_urls: [
      "https://cdn.example.com/mask-1.png",
      "https://cdn.example.com/mask-2.png",
      "https://cdn.example.com/mask-3.png",
      "https://cdn.example.com/mask-4.png",
    ],
  }), /mask_urls.*no more than 3/i);
});

test("model-aware scalar validation rejects invalid prompt, quality, duration, aspect ratio, and seed", async () => {
  const operation = getPlatformOperation("video.text");
  const base = { prompt: "hello", model: "v6", quality: "720p", duration: 5, aspect_ratio: "16:9" };
  const cases = [
    [{ ...base, prompt: "" }, /prompt/i],
    [{ ...base, prompt: "x".repeat(5001) }, /prompt/i],
    [{ ...base, quality: "cinema" }, /quality/i],
    [{ ...base, duration: 16 }, /duration/i],
    [{ ...base, aspect_ratio: "square-ish" }, /aspect/i],
    [{ ...base, seed: -1 }, /seed/i],
    [{ ...base, seed: 2_147_483_648 }, /seed/i],
  ];
  for (const [input, pattern] of cases) {
    await assert.rejects(normalizeAndValidatePlatformInput(operation, input), pattern);
  }
});

test("fusion enforces exact model duration, quality, aspect, and omni-video rules", async () => {
  const operation = getPlatformOperation("video.fusion");
  const base = {
    image_references: [{ img_id: "1", ref_name: "subject" }],
    prompt: "Animate @subject",
    quality: "720p",
  };
  for (const input of [
    { ...base, model: "v4.5", duration: 5, aspect_ratio: "16:9" },
    { ...base, model: "v5.6", duration: 10, aspect_ratio: "9:16" },
    { ...base, model: "v6", duration: 1, aspect_ratio: "21:9" },
    { ...base, model: "v6", duration: 5, aspect_ratio: "auto", reference_mode: "omni" },
    {
      ...base, model: "v6", duration: 0, aspect_ratio: "2:3", reference_mode: "omni",
      video_references: [{ video_id: "2", ref_name: "motion" }],
    },
  ]) {
    await normalizeAndValidatePlatformInput(operation, input);
  }
  for (const input of [
    { ...base, model: "v4.5", duration: 10, aspect_ratio: "16:9" },
    { ...base, model: "v5.6", duration: 10, quality: "1080p", aspect_ratio: "16:9" },
    { ...base, model: "v5.6", duration: 5, aspect_ratio: "21:9" },
    { ...base, model: "v6", duration: 16, aspect_ratio: "16:9" },
  ]) {
    await assert.rejects(normalizeAndValidatePlatformInput(operation, input), /duration|aspect_ratio|reference_mode/i);
  }
});

test("official multi-transition order and bounds are validated", async () => {
  const operation = getPlatformOperation("video.multi-transition");
  const base = { model: "v5", quality: "720p" };
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 3 }],
  }), /2.*7/i);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1" }, { img_id: "2" }],
  }), /duration.*last/i);
  const result = await normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 3 }, { img_id: "2" }],
  });
  assert.equal(result.payload.multi_transition[0].img_id, "1");

  const sentinel = await normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 3 }, { img_id: "2", duration: 0 }],
  });
  assert.equal(sentinel.payload.multi_transition[1].duration, 0);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 0 }, { img_id: "2" }],
  }), /duration.*1 to 8/i);
  // Documented bounds: 1-8 per item, 1-5 with three or more items, last item 0 or omitted.
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 9 }, { img_id: "2" }],
  }), /duration.*1 to 8/i);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 6 }, { img_id: "2", duration: 5 }, { img_id: "3" }],
  }), /duration.*1 to 5/i);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...base,
    multi_transition: [{ img_id: "1", duration: 3 }, { img_id: "2", duration: 4 }],
  }), /last.*0 or omitted/i);
});

test("official mutually-exclusive source and lip-sync combinations are validated", async () => {
  await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("video.extend"), {
    source_video_id: "1", video_media_id: "2", prompt: "continue", seed: 1,
    quality: "720p", duration: 5, model: "v6",
  }), /exactly one.*source_video_id.*video_media_id/i);
  await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("video.lip-sync"), {
    source_video_id: "1", audio_media_id: "2",
    lip_sync_tts_speaker_id: "3", lip_sync_tts_content: "hello",
  }), /either.*audio_media_id.*tts/i);
});

test("swap and swap-mask accept positive keyframe identifiers after string-safe normalization", async () => {
  const swap = await normalizeAndValidatePlatformInput(getPlatformOperation("video.swap"), {
    source_video_id: "1",
    keyframe_id: 7,
    mask_id: "2",
    img_id: "3",
    quality: "720p",
  });
  assert.equal(swap.payload.keyframe_id, "7");

  const mask = await normalizeAndValidatePlatformInput(getPlatformOperation("video.swap-mask"), {
    video_media_id: "4",
    keyframe_id: "12",
  });
  assert.equal(mask.payload.keyframe_id, "12");

  // The documented keyframe range starts at 1 for swap-mask as well as swap.
  await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("video.swap-mask"), {
    source_video_id: "5",
    keyframe_id: 0,
  }), /keyframe_id/);
});

test("keyframe identifiers apply endpoint-specific zero rules and reject invalid values", async () => {
  const maskOperation = getPlatformOperation("video.swap-mask");
  for (const keyframe_id of [-1, "-1", "1.5", "frame-one", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(normalizeAndValidatePlatformInput(maskOperation, {
      source_video_id: "1",
      keyframe_id,
    }), /keyframe_id|string|safe integer/i);
  }
  for (const keyframe_id of [0, "0"]) {
    await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("video.swap"), {
      source_video_id: "1",
      keyframe_id,
      mask_id: "2",
      img_id: "3",
      quality: "720p",
    }), /keyframe_id/i);
  }
});

test("read-only query fields are separated and validated without losing unknown payload fields", async () => {
  const result = await normalizeAndValidatePlatformInput(getPlatformOperation("resource.tts-speakers"), {
    page_num: 1,
    page_size: 20,
    speaker_type: "custom",
    future_filter: "kept",
  });
  assert.deepEqual(result.query, { page_num: 1, page_size: 20, speaker_type: "custom" });
  assert.deepEqual(result.payload, { future_filter: "kept" });
  await assert.rejects(normalizeAndValidatePlatformInput(getPlatformOperation("resource.tts-speakers"), {
    page_size: 25,
  }), /page_size/i);
});

test("checked-in tiny media fixtures are non-empty and viral-agent local references use injected media policy", async () => {
  for (const name of ["tiny.png", "tiny.mp4", "tiny.wav"]) {
    const stats = await fs.stat(new URL(`../fixtures/media/${name}`, import.meta.url));
    assert.ok(stats.size > 0, `${name} must be a non-empty fixture`);
  }

  const operation = getPlatformOperation("agent.viral-recreation");
  const input = {
    agent_id: "414562414124109",
    prompt: "Recreate this rhythm without copying branding.",
    quality: "720p",
    img_references: [{ img_id: "11", file: "/safe/tiny.png" }],
    video_references: [{ video_media_id: "12", file: "/safe/tiny.mp4" }],
  };
  const calls = [];
  const validated = await normalizeAndValidatePlatformInput(operation, input, {
    inspectLocalMedia: async (file, options) => {
      calls.push({ file, options });
      return file.endsWith(".png")
        ? { size_bytes: 100, width: 1000, height: 1000 }
        : { size_bytes: 100, width: 1080, height: 1080, duration_seconds: 15 };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.maxBytes, 20 * 1024 * 1024);
  assert.equal(calls[1].options.maxBytes, 100 * 1024 * 1024);
  // Local paths only drive the media checks; the API receives the uploaded IDs.
  assert.deepEqual(validated.payload.img_references, [{ img_id: "11" }]);
  assert.deepEqual(validated.payload.video_references, [{ video_media_id: "12" }]);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...input,
    img_references: [{ img_url: "https://cdn.example.test/a.png" }],
  }), /img_references\[0\] requires an img_id/);
  await assert.rejects(normalizeAndValidatePlatformInput(operation, {
    ...input,
    img_references: [{ img_id: "11" }],
    video_references: [{ video_url: "https://cdn.example.test/a.mp4" }],
  }), /video_references\[0\]/);

  await assert.rejects(normalizeAndValidatePlatformInput(operation, input, {
    inspectLocalMedia: async (file) => file.endsWith(".png")
      ? { size_bytes: 100, width: 1000, height: 1000 }
      : { size_bytes: 100, width: 1080, height: 1080, duration_seconds: 31 },
  }), /duration.*2.*30/i);
});

test("validators follow the documented field rules found in the API doc review", async () => {
  const validate = (id, input) => normalizeAndValidatePlatformInput(getPlatformOperation(id), input);

  // Template prompts may be empty because the template supplies them.
  const template = await validate("video.template", {
    template_id: "302325299692608", img_id: "1", model: "v6", duration: 5, quality: "720p",
  });
  assert.equal(template.payload.prompt, "");

  // Sound effects describe the sound with sound_effect_content; prompt is not an API field.
  await validate("video.sound-effect", { video_media_id: "1" });
  await assert.rejects(validate("video.sound-effect", { video_media_id: "1", prompt: "Rain" }), /sound_effect_content/);
  await assert.rejects(validate("video.sound-effect", { video_media_id: "1", original_sound_switch: "yes" }), /boolean/);

  // Music MV: aspect_ratio and quality are optional, and the style lists match the public doc.
  const mvBase = { mv_agent_type: "vibe_mv_v3_custom", audio_media_id: "1" };
  await validate("agent.music-mv", mvBase);
  await validate("agent.music-mv", { ...mvBase, music_style: "Hip Hop", mv_style: "Golden Age" });
  await assert.rejects(validate("agent.music-mv", { ...mvBase, mv_style: "Vintage" }), /mv_style/);
  await assert.rejects(validate("agent.music-mv", {
    ...mvBase, mv_style: "Cinematic", style_img_references: [{ img_id: "2" }],
  }), /style_img_references.*Custom/);

  // Transition only reads first_frame_img/last_frame_img.
  await assert.rejects(validate("video.transition", {
    prompt: "Morph", model: "v6", duration: 5, quality: "720p", first_frame_url: "https://cdn.example.test/a.png", last_frame_img: "2",
  }), /first_frame_img is required/);

  // Avatar TTS scripts must be 30-200 characters.
  await assert.rejects(validate("video.avatar", {
    img_id: "1", quality: "720p", lip_sync_tts_speaker_id: "auto", lip_sync_tts_content: "Too short.",
  }), /30 to 200/);

  // v6 omni fusion may reference only videos, at most two.
  const omni = { model: "v6", reference_mode: "omni", prompt: "Recreate @video1", duration: 0, quality: "720p", aspect_ratio: "auto" };
  await validate("video.fusion", { ...omni, video_references: [{ video_media_id: "1" }] });
  await assert.rejects(validate("video.fusion", {
    ...omni, video_references: [{ video_media_id: "1" }, { video_media_id: "2" }, { video_media_id: "3" }],
  }), /two reference videos/);

  // Extend is not available on c1; real-estate pro-only fields are rejected for fast.
  await assert.rejects(validate("video.extend", {
    source_video_id: "1", prompt: "Continue", seed: 1, quality: "720p", duration: 5, model: "c1",
  }), /extend model/);
  await assert.rejects(validate("agent.real-estate", {
    agent_id: "419629433597950", model: "fast", product_url: "https://listing.example.test/home", video_style: "cozy",
  }), /video_style.*pro/);

  // Template list query values are documented as strings.
  const templates = await validate("resource.templates", { page: "1", pageSize: "50" });
  assert.equal(templates.query.pageSize, "50");

  // Restyle seeds share the documented 32-bit ceiling.
  await assert.rejects(validate("video.restyle", { video_media_id: "1", restyle_id: "2", seed: 2_147_483_648 }), /seed/);
});
