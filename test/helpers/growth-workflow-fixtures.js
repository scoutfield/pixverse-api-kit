export const imageUrl = "https://media.pixverse.ai/marketing_hub_website/upload/product.webp";
export function payloads() {
  return {
    template: {
      template_id: 0,
      product: { title: "Linen shirt", images: [{ url: imageUrl }] },
      video: { language: "en-US", voiceover: false, captions: false, background_music: false, callout_text_switch: true },
    },
    "viral-clone": {
      source_video_id: "7412583960987654321", model: "standard", script_language: "en-US",
      listing: { title: "Linen shirt", image_info: { items: [{ url: "https://shop.example.test/shirt.webp", sort: 0 }] } },
      video: { aspect_ratio: "9:16", resolution: "768p", language: "en-US" }, avatar: { mode: "disabled" },
    },
    variation: {
      source_video_id: "7412583960987654321",
      videos: [{ avatar: { mode: "keep" }, scene: { mode: "text", description: "A bright kitchen" }, language: { code: "en-US" } }],
    },
    "product-suite": {
      platform: "amazon", marketplace: "amazon.com", language: "en-US",
      product: { title: "Travel mug", images: [{ url: imageUrl }] }, image_types: ["main", "lifestyle"],
    },
    "video-import": { url: "https://media.example.test/reference.mp4?signature=private-fixture" },
  };
}
