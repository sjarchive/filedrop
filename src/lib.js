/**
 * Pure helper utilities for FileDrop (decoupled for fast deterministic testing).
 */

export const HEX_ID_RE = /^[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export function isValidHexId(id) {
  return HEX_ID_RE.test(String(id || ''));
}

export function isValidSha256(hash) {
  return SHA256_RE.test(String(hash || ''));
}

export function normalizeEndpoint(endpoint) {
  return String(endpoint || '').replace(/\/+$/, '');
}

export function sanitizeName(name) {
  const s = typeof name === 'string' ? name : '';
  const cleaned = (s || 'file')
    .replace(/[\x00-\x1f\x7f\\/#?"<>|:]/g, '_')
    .trim()
    .slice(0, 180)
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

export function sanitizeContentType(type) {
  const cleaned = String(type || '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'application/octet-stream';
}

// RFC 3986 percent-encoding for a single S3 object key segment
export function encodeRfc3986Segment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

// URL-encoded S3 key stored in KV and appended to bucket URLs
export function objectKey(id, name) {
  return ['files', id, sanitizeName(name)].map(encodeRfc3986Segment).join('/');
}

// Encode a raw (unencoded) S3 key returned by ListObjectVersions into URL path segments
export function encodeKeyPath(rawKey) {
  return String(rawKey || '')
    .split('/')
    .map(encodeRfc3986Segment)
    .join('/');
}

// Decode a stored/URL-encoded key back to the raw S3 key reported by ListObjectVersions
export function decodeObjectKey(encodedKey) {
  return String(encodedKey || '')
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

// Extract the 16-hex file id from a raw S3 key like "files/<id>/<name>"
export function extractFileIdFromRawKey(rawKey) {
  const parts = String(rawKey || '').split('/');
  if (parts.length < 3 || parts[0] !== 'files') return null;
  return isValidHexId(parts[1]) ? parts[1] : null;
}

// Build an RFC 6266 + RFC 5987 Content-Disposition header with safe ASCII fallback
export function encodeContentDisposition(name) {
  const safeName = sanitizeName(name || 'file');
  const asciiFallback = safeName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .trim() || 'file';
  const rfc5987 = encodeRfc3986Segment(safeName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${rfc5987}`;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readXmlTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(block);
  return m ? decodeXmlEntities(m[1]) : null;
}

/**
 * Parse an S3 / Backblaze B2 ListObjectVersions XML response.
 * Returns { versions, deleteMarkers, isTruncated, nextKeyMarker, nextVersionIdMarker }.
 */
export function parseListVersionsXml(xml) {
  const text = String(xml || '');
  const versions = [];
  const deleteMarkers = [];

  for (const m of text.matchAll(/<Version>([\s\S]*?)<\/Version>/g)) {
    const block = m[1];
    const key = readXmlTag(block, 'Key');
    const versionId = readXmlTag(block, 'VersionId');
    if (key != null && versionId != null) {
      versions.push({
        key,
        versionId,
        isLatest: readXmlTag(block, 'IsLatest') === 'true',
        lastModified: readXmlTag(block, 'LastModified'),
      });
    }
  }

  for (const m of text.matchAll(/<DeleteMarker>([\s\S]*?)<\/DeleteMarker>/g)) {
    const block = m[1];
    const key = readXmlTag(block, 'Key');
    const versionId = readXmlTag(block, 'VersionId');
    if (key != null && versionId != null) {
      deleteMarkers.push({
        key,
        versionId,
        isLatest: readXmlTag(block, 'IsLatest') === 'true',
        lastModified: readXmlTag(block, 'LastModified'),
      });
    }
  }

  return {
    versions,
    deleteMarkers,
    isTruncated: readXmlTag(text, 'IsTruncated') === 'true',
    nextKeyMarker: readXmlTag(text, 'NextKeyMarker'),
    nextVersionIdMarker: readXmlTag(text, 'NextVersionIdMarker'),
  };
}
