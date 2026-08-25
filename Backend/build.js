/**
 * build.js — SEO static post-link generator.
 *
 * WHY THIS EXISTS
 * ---------------
 * The homepage (`Frontend/index.html`) renders its post cards with
 * client-side JavaScript: the raw HTML shipped to the browser contains an
 * empty `#posts` container, so search-engine crawlers that don't execute JS
 * (Googlebot included) see NO links to any article. Google then reports those
 * pages as "Discovered – currently not indexed".
 *
 * This script runs at build/deploy time (Render Build Command) and injects a
 * real, static `<a href="/slug">Title</a>` link for every
 * published post directly into `Frontend/index.html`, between the
 * `SEO_STATIC_POST_LINKS_START` / `SEO_STATIC_POST_LINKS_END` marker comments.
 * The links are then part of the raw HTML source — no JS required.
 *
 * The client-side rendering is untouched: when the page loads in a browser,
 * the existing JS still fetches fresh data from Sanity and replaces the
 * static links with the full post cards, exactly as before.
 *
 * NOTE: Backend/server.js ALSO injects these links dynamically when the
 * homepage is served (cached 1 hour), so links stay fresh without rebuilds.
 * This script remains as the build-time fallback that keeps the committed
 * index.html populated for static hosts and direct file access.
 *
 * USAGE
 * -----
 *   cd Backend
 *   npm install          # one-time
 *   npm run build        # or: node build.js
 *
 * Env overrides (optional — defaults match sanity.config.js / server.js):
 *   SANITY_PROJECT_ID, SANITY_DATASET
 *
 * NOTE: If the Sanity query fails (e.g. temporary network issue), the script
 * logs a warning and leaves the previously generated links in place so a
 * deploy is never blocked by a transient Sanity outage.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@sanity/client');

// Same project / dataset / API version used everywhere else in the codebase
// (Sanity-Backend/sanity.config.js, Backend/server.js, Frontend JS).
const PROJECT_ID = process.env.SANITY_PROJECT_ID || 'xsd8o1za';
const DATASET = process.env.SANITY_DATASET || 'production';
const API_VERSION = '2024-01-01';

// All published, non-draft posts that belong on the BLOG feed (Sanity's query
// API only returns published documents by default). Matches the postType
// filter used by the frontend's blog query so journal/private posts never
// appear on the homepage's static shell. We fetch enough fields to render a
// full-looking card (cover image, excerpt, author, date) so the static
// fallback never looks like plain text links.
const GROQ = `*[_type == "post" && (!defined(postType) || postType in ["blog", "premium"])]{
  title, slug, excerpt, publishedAt, _createdAt, readingTime, isPrivate, isPremium, postType,
  "authorName": author->name,
  "authorImage": author->image.asset->url,
  "mainImageUrl": mainImage.asset->url,
  "ogImageUrl": ogImage.asset->url,
  "categories": categories[]->title
}`;

const client = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: API_VERSION,
  // Uncacheted API (not useCdn) on purpose: the build often runs seconds after
  // a Sanity publish webhook fires, and the CDN can lag ~1 minute — which
  // would leave the brand-new post out of the very deploy it triggered.
  useCdn: false, // public read-only access — no token required
});

const INDEX_HTML = path.join(__dirname, '..', 'Frontend', 'index.html');
const START_MARKER = '<!-- SEO_STATIC_POST_LINKS_START -->';
const END_MARKER = '<!-- SEO_STATIC_POST_LINKS_END -->';

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Sanity CDN image with resize/format params (mirrors the server's sanityImg
// helper) so fallback cards load compressed WebP thumbnails, not originals.
function cardImg(url, w = 600, q = 70) {
  if (!url || typeof url !== 'string') return '';
  if (!url.includes('cdn.sanity.io')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}auto=format&fit=max&w=${w}&q=${q}`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr ago`;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function initials(name) {
  if (!name) return '?';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Builds the HTML block that replaces the placeholder area inside `#posts`.
 * Cards reuse the site's existing `.card` styles and mirror the shape of the
 * JS-rendered cards (cover image, title, excerpt, author, date), so the
 * no-JS / fallback state looks like the real blog — never plain text links.
 */
function buildLinksBlock(posts) {
  const links = posts
    .filter((post) => post && post.slug && post.slug.current)
    .map((post) => {
      const slug = encodeURIComponent(post.slug.current);
      const title = escapeHtml(post.title || 'Untitled');
      // Posts live under a type prefix: /blog/<slug> or /journal/<slug>.
      const prefix = post.postType === 'journal' ? 'journal' : 'blog';
      const imageUrl = cardImg(post.ogImageUrl || post.mainImageUrl);
      const isPremium =
        post.postType === 'premium' || Boolean(post.isPremium);
      const isPrivate = Boolean(post.isPrivate);
      const excerpt = escapeHtml(post.excerpt || '');
      const authorName = escapeHtml(post.authorName || 'Unknown');
      const authorImage = post.authorImage || '';
      const dateStr = timeAgo(post.publishedAt || post._createdAt);
      const cats = Array.isArray(post.categories)
        ? post.categories
            .filter(Boolean)
            .map((c) => `<span class="card-cat">${escapeHtml(c)}</span>`)
            .join('')
        : '';
//
      return (
        `<a class="card seo-static-post" href="/${prefix}/${slug}"` +
        (isPrivate ? ' data-private="true"' : '') +
        '>' +
        (isPremium
          ? '<div class="card-premium" title="Premium post">★</div>'
          : '') +
        (isPrivate
          ? '<div class="card-lock" title="Private post">🔒</div>'
          : '') +
        (imageUrl
          ? `<img src="${imageUrl}" alt="${title}" loading="lazy" decoding="async" />`
          : '') +
        '<div class="card-body">' +
        (cats ? `<div class="card-cats">${cats}</div>` : '') +
        `<h3>${title}</h3>` +
        (excerpt ? `<p>${excerpt}</p>` : '') +
        '<div class="card-footer">' +
        '<div class="author">' +
        '<div class="author-avatar">' +
        (authorImage
          ? `<img src="${authorImage}" alt="${authorName}" />`
          : initials(post.authorName || '')) +
        '</div>' +
        `<span class="author-name">${authorName}</span>` +
        '</div>' +
        '<div class="card-meta">' +
        (post.readingTime
          ? `<span class="reading-time">⏱ ${post.readingTime} min</span>`
          : '') +
        (dateStr ? `<span class="date-str">📅 ${dateStr}</span>` : '') +
        '</div>' +
        '</div>' +
        '</div>' +
        '</a>'
      );
    });

  const indent = '            '; // matches the indentation of the markers in index.html
  const body = links.length ? links.join(`\n${indent}`) : '';
  return `${START_MARKER}\n${indent}${body}\n${indent}${END_MARKER}`;
}

async function main() {
  console.log(
    `[build] Fetching published posts from Sanity (${PROJECT_ID}/${DATASET})…`
  );

  let posts;
  try {
    posts = await client.fetch(GROQ);
  } catch (err) {
    // Non-fatal: keep the existing (last good) static links instead of
    // failing the whole deploy because of a transient Sanity/network issue.
    console.warn(
      `[build] WARNING: Could not fetch posts from Sanity (${err.message || err}). ` +
        `Keeping existing static links in ${INDEX_HTML}.`
    );
    process.exit(0);
  }

  if (!Array.isArray(posts) || posts.length === 0) {
    console.warn('[build] WARNING: No published posts returned from Sanity.');
  }

  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const startIdx = html.indexOf(START_MARKER);
  const endIdx = html.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    console.error(
      `[build] ERROR: Could not find the SEO markers in ${INDEX_HTML}. ` +
        `Make sure these comments exist inside the #posts container:\n` +
        `  ${START_MARKER}\n  ${END_MARKER}`
    );
    process.exit(1);
  }

  const block = buildLinksBlock(posts);
  const updated =
    html.slice(0, startIdx) + block + html.slice(endIdx + END_MARKER.length);

  fs.writeFileSync(INDEX_HTML, updated);
  console.log(
    `[build] Injected ${posts.length} static post link(s) into ${path.relative(process.cwd(), INDEX_HTML)}`
  );
}
//
main().catch((err) => {
  console.error('[build] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
