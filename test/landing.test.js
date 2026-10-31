import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const menu = html.slice(html.indexOf('<div id="menu"'), html.indexOf('<div id="pause"'));
const link = menu.match(/<a\b[^>]*href="https:\/\/github\.com\/roryp\/racing"[^>]*>[\s\S]*?<\/a\s*>/)?.[0];

describe("landing page repository link", () => {
  it("links to the GitHub repository from the start menu", () => {
    assert.ok(link, "the start menu must include a link to roryp/racing");
    assert.match(link, />\s*View source on GitHub\s*<\/a\s*>/);
  });

  it("opens safely in a new tab and announces that behavior", () => {
    assert.ok(link);
    assert.match(link, /\btarget="_blank"/);
    const rel = link.match(/\brel="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    assert.ok(rel.includes("noopener"));
    assert.ok(rel.includes("noreferrer"));
    assert.match(link, /\baria-label="View source on GitHub \(opens in a new tab\)"/);
  });
});
