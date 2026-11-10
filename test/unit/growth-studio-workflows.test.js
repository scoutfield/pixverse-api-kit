import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkflowPayload, SUITE_MARKETPLACES, SUITE_IMAGE_TYPES } from "../../src/growth-studio/workflows.js";
import { payloads, imageUrl } from "../helpers/growth-workflow-fixtures.js";

test("new workflow payloads retain false switches, zero template IDs, and string resource IDs", () => {
  for (const [name, body] of Object.entries(payloads())) {
    const original = structuredClone(body);
    assert.deepEqual(normalizeWorkflowPayload(name, body), original);
    assert.deepEqual(body, original);
  }
});

test("template permits URL products, ten images, nullable optional text switch and no avatar", () => {
  const p = payloads().template;
  p.product.images = Array.from({ length: 10 }, () => ({ url: imageUrl }));
  p.video.callout_text_switch = null;
  p.video.avatar_url = "";
  normalizeWorkflowPayload("template", p);
  p.product = { source_url: "https://shop.example.test/shirt" };
  normalizeWorkflowPayload("template", p);
  for (const field of ["voiceover", "captions", "background_music"]) {
    for (const invalid of [undefined, null, 0, "false"]) {
      assert.throws(() => normalizeWorkflowPayload("template", { ...p, video: { ...p.video, [field]: invalid } }), /boolean/);
    }
  }
});

test("validation rejects contradictory and undocumented billable parameters", () => {
  const cases = [
    ["template", (p) => { p.template_id = "0"; }],
    ["template", (p) => { p.video.duration = 10; }],
    ["template", (p) => { p.product.images[0].url += "?x=y"; }],
    ["template", (p) => { p.product.images[0].url = "https://media.pixverse.ai.evil.test/a"; }],
    ["template", (p) => { p.product.price = { amount: 20, currency: "USD" }; }],
    ["template", (p) => { p.product.images = Array(11).fill({ url: imageUrl }); }],
    ["viral-clone", (p) => { p.source_video_id = 123; }],
    ["viral-clone", (p) => { p.video.resolution = "720p"; }],
    ["viral-clone", (p) => { p.video.duration_seconds = 15; }],
    ["viral-clone", (p) => { p.avatar = { mode: "auto" }; }],
    ["viral-clone", (p) => { p.avatar = { mode: "custom", url: imageUrl, avatar_id: "123" }; }],
    ["viral-clone", (p) => { p.avatar = { mode: "disabled", url: imageUrl }; }],
    ["viral-clone", (p) => { p.avatar = { mode: "custom", url: "https://shop.example.test/avatar.png" }; }],
    ["variation", (p) => { p.videos = Array(21).fill(p.videos[0]); }],
    ["variation", (p) => { p.videos[0].avatar.description = "new person"; }],
    ["variation", (p) => { p.videos[0].scene.image_url = imageUrl; }],
    ["variation", (p) => { p.videos[0].scene.description = "  "; }],
    ["variation", (p) => { p.videos[0].language.code = "en"; }],
    ["product-suite", (p) => { p.marketplace = "amazon.co.jp"; }],
    ["product-suite", (p) => { p.quality = "high"; }],
    ["product-suite", (p) => { p.image_types = ["main", "main"]; }],
    ["product-suite", (p) => { p.product.images = Array(10).fill({ url: imageUrl }); }],
    ["video-import", (p) => { p.url = "file:///tmp/video.mp4"; }],
    ["video-import", (p) => { p.url = "https://name:password@example.test/video"; }],
    ["video-import", (p) => { p.video_id = "1"; }],
  ];
  for (const [name, mutate] of cases) {
    const p = payloads()[name]; mutate(p);
    assert.throws(() => normalizeWorkflowPayload(name, p), undefined, `${name}: ${JSON.stringify(p).slice(0, 150)}`);
  }
});

test("all documented marketplace/language pairs validate; Walmart Mexico excludes its last three image types", () => {
  for (const [platform, marketplaces] of Object.entries(SUITE_MARKETPLACES)) {
    for (const [marketplace, languages] of Object.entries(marketplaces)) {
      for (const language of languages) normalizeWorkflowPayload("product-suite", {
        ...payloads()["product-suite"], platform, marketplace, language, image_types: [SUITE_IMAGE_TYPES[platform][0]],
      });
    }
  }
  const mx = { ...payloads()["product-suite"], platform: "walmart", marketplace: "walmart.com.mx", language: "es-MX" };
  for (const type of ["dimensions_scale", "category_supplement", "package_contents"]) {
    assert.throws(() => normalizeWorkflowPayload("product-suite", { ...mx, image_types: [type] }), /image_types/);
  }
});

test("request size limits count UTF-8 bytes before submission", () => {
  assert.throws(() => normalizeWorkflowPayload("video-import", { url: `https://example.test/${"a".repeat(65536)}` }), /65536 bytes/);
  const p = payloads().variation;
  p.videos[0].scene.description = "猫".repeat(350000);
  assert.throws(() => normalizeWorkflowPayload("variation", p), /1048576 bytes/);
});

test("viral clone supports saved listings and custom system avatar IDs; variations preserve server deduplication inputs", () => {
  const p = payloads()["viral-clone"];
  p.listing = { listing_id: "7412583960987654321" };
  p.avatar = { mode: "custom", avatar_id: "7412583960987654322" };
  normalizeWorkflowPayload("viral-clone", p);
  const v = payloads().variation;
  v.videos[0].language.code = " en-US ";
  v.videos.push(structuredClone(v.videos[0]));
  assert.equal(normalizeWorkflowPayload("variation", v).videos.length, 2);
});
