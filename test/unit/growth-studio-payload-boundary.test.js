import assert from "node:assert/strict";
import test from "node:test";

import { validateCreatePayload } from "../../src/client.js";

const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
};

const video = (overrides = {}) => ({
  aspect_ratio: "9:16",
  duration_seconds: 15,
  resolution: "720p",
  language: "en-US",
  voiceover: true,
  captions: true,
  background_music: true,
  avatar: { mode: "auto" },
  ...overrides,
});

test("Growth Studio accepts a neutral product URL payload without mutation", () => {
  const payload = freeze({
    product: { source_url: "https://shop.example.com/products/example-item" },
    video: video({ folder_id: "630251570268735431" }),
  });

  assert.doesNotThrow(() => validateCreatePayload(payload));
  assert.deepEqual(payload, {
    product: { source_url: "https://shop.example.com/products/example-item" },
    video: video({ folder_id: "630251570268735431" }),
  });
});

test("Growth Studio accepts only PixVerse upload URLs for image payloads", () => {
  assert.doesNotThrow(() => validateCreatePayload(freeze({
    product: {
      title: "Example item",
      images: [{ url: "https://media.pixverse.ai/marketing_hub_website/openapi_video_inputs/uploads/example/product.webp" }],
    },
    video: video(),
  })));

  assert.throws(() => validateCreatePayload({
    product: { title: "Example item", images: [{ url: "https://shop.example.com/product.webp" }] },
    video: video(),
  }), /Product images must use URLs returned by the image upload endpoint/);
});

test("Growth Studio rejects unsafe numeric folder IDs before network access", () => {
  assert.throws(() => validateCreatePayload({
    product: { source_url: "https://shop.example.com/products/example-item" },
    video: video({ folder_id: 630251570268735431 }),
  }), /folder_id must be a numeric string/);
});

test("Growth Studio rejects a top-level folder_id because it belongs at video.folder_id", () => {
  assert.throws(() => validateCreatePayload({
    folder_id: "630251570268735431",
    product: { source_url: "https://shop.example.com/products/example-item" },
    video: video(),
  }), /video\.folder_id/);
});
