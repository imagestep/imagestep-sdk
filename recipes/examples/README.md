# Example inputs

Enough to run every recipe from zero. All three pictures were generated with ImageStep itself (`generate` on
`google/gemini-3.1-flash-image-preview`, 2026-09-23), resized to 1024 px on the long edge, JPEG 88. The brand on the
mug, **Ambermoss**, is made up.

| File | Used by | Prompt |
|---|---|---|
| `hero.jpg` | social-carousel (`--refs`) | Character reference for a hiking brand mascot: a woman in her thirties with short silver hair, a navy rain jacket and a mustard beanie, full body, standing, facing the viewer, plain light grey background, clean flat modern illustration style. |
| `product.jpg` | product-scenes (`--refs`), product-trio | Product photograph of a dark green enamel camping mug with a white rim and a small orange AMBERMOSS wordmark on the front, standing on a plain light grey studio background, soft even light, the mug centred and filling about half the frame. Square format. No other text or logos. |
| `field/camp-morning.jpg` | field-photo-ingest | Phone photo of a dark green enamel camping mug with a white rim, steaming on a weathered wooden picnic table at a forest campsite, early morning light, a plain unbranded tent out of focus behind it. No logos, brand names or text anywhere in the picture. |

**The field photo's EXIF is written, not shot.** A generated picture carries no metadata, so the date and place that
field-photo-ingest reads were added afterwards: `DateTimeOriginal` 2026-08-14 07:32:10, GPS 37.7456 N, 119.5936 W
(Yosemite Valley). Run the recipe on your own phone's photos for the real thing.

How they were made: the ImageStep repo's recipes test (`pnpm test:e2e:recipes --make-inputs`) generates any of these
that is missing, with the prompts above.
