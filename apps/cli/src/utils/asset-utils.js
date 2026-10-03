import path from "path";

// Comprehensive extension to MIME type mapping
const EXTENSION_TO_MIME = {
  // Standard images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
  jxl: "image/jxl",
  jp2: "image/jp2",
  j2k: "image/jp2",
  psd: "image/vnd.adobe.photoshop",
  ico: "image/vnd.microsoft.icon",
  // HEIF/HEIC formats
  heic: "image/heic",
  heif: "image/heif",
  heics: "image/heic-sequence",
  heifs: "image/heif-sequence",
  // RAW camera formats
  cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3",
  crw: "image/x-canon-crw",
  nef: "image/x-nikon-nef",
  nrw: "image/x-nikon-nrw",
  arw: "image/x-sony-arw",
  sr2: "image/x-sony-sr2",
  srf: "image/x-sony-srf",
  orf: "image/x-olympus-orf",
  raw: "image/x-panasonic-raw",
  rw2: "image/x-panasonic-rw2",
  raf: "image/x-fuji-raf",
  pef: "image/x-pentax-pef",
  dng: "image/x-adobe-dng",
  mrw: "image/x-minolta-mrw",
  srw: "image/x-samsung-srw",
  "3fr": "image/x-hasselblad-3fr",
  fff: "image/x-hasselblad-fff",
  iiq: "image/x-phaseone-iiq",
  mef: "image/x-mamiya-mef",
  dcr: "image/x-kodak-dcr",
  k25: "image/x-kodak-k25",
  kdc: "image/x-kodak-kdc",
  x3f: "image/x-sigma-x3f",
  rwl: "image/x-leica-rwl",
  // Videos
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  // Documents
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json"
};

/**
 * Normalize MIME type filter input to array of full MIME types
 * Handles flexible input like: 'image/jpeg', 'jpeg', 'jpg', 'JPG', 'JPEG', etc.
 * @param {Array<string>|undefined} filterInput - Raw filter input from CLI
 * @returns {Array<string>|null} Normalized array of MIME types or null if no filter
 */
export function normalizeMimeTypeFilter(filterInput) {
  if (!filterInput || filterInput.length === 0) {
    return null;
  }

  const normalized = [];

  for (const input of filterInput) {
    const lowerInput = input.toLowerCase().trim();

    // Check if it's already a full MIME type
    if (lowerInput.includes("/")) {
      normalized.push(lowerInput);
    } else {
      // It's a short form like 'jpg', 'jpeg', 'png'
      const mimeType = EXTENSION_TO_MIME[lowerInput];
      if (mimeType) {
        normalized.push(mimeType);
      } else {
        // Assume it's a subtype, prepend 'image/'
        normalized.push(`image/${lowerInput}`);
      }
    }
  }

  // Remove duplicates
  return [...new Set(normalized)];
}

/**
 * Check if a detected MIME type matches the filter
 * @param {string} detectedMimeType - The detected MIME type of the file
 * @param {Array<string>} normalizedFilter - Normalized MIME type filter array
 * @returns {boolean} True if matches filter
 */
export function matchesMimeTypeFilter(detectedMimeType, normalizedFilter) {
  if (!normalizedFilter || normalizedFilter.length === 0) {
    return true;
  }

  const lowerDetected = detectedMimeType.toLowerCase();
  return normalizedFilter.includes(lowerDetected);
}

/**
 * Get MIME type based on file extension
 * @param {string} filePath - Path to the file
 * @returns {string} MIME type
 */
export function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1); // Remove leading dot
  return EXTENSION_TO_MIME[ext] || "application/octet-stream";
}

/**
 * The extension for a MIME type, read backwards off the same table — the one extension ↔ MIME
 * list in this package (#259). The first spelling wins, so `image/jpeg` is `.jpg`, not `.jpeg`.
 * @param {string|null} mimeType - A MIME type, parameters allowed (`image/png; q=1`)
 * @returns {string} `.ext`, or "" when the table does not know the type
 */
export function extensionForMime(mimeType) {
  const bare = (mimeType || "").split(";")[0].trim().toLowerCase();
  const found = Object.entries(EXTENSION_TO_MIME).find(([, mime]) => mime === bare);
  return found ? `.${found[0]}` : "";
}
