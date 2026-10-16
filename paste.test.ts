// @vitest-environment happy-dom
//
// The converter behind pasting rendered chat output into a note.
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./paste";

describe("htmlToMarkdown", () => {
  it("rebuilds a bulleted list with bold and code from a copied message", () => {
    const html = `
      <p>The watcher had failed straight away.</p>
      <ul>
        <li><strong>Cause:</strong> this session runs in a new thread (<code>thr_57navi8ds7</code>).</li>
        <li><strong>Fix:</strong> call those scripts with the folder named.</li>
      </ul>`;
    expect(htmlToMarkdown(html)).toBe(
      [
        "The watcher had failed straight away.",
        "",
        "- **Cause:** this session runs in a new thread (`thr_57navi8ds7`).",
        "- **Fix:** call those scripts with the folder named.",
      ].join("\n"),
    );
  });

  it("turns bb mention pills back into their source text, not their truncated label", () => {
    const html = `<ul><li>see <a class="prompt-mention-pill" data-prompt-mention="true"
      data-prompt-mention-serialized-text="thr_57navi8ds7" href="/projects/p/threads/thr_57navi8ds7"
      ><svg></svg><span class="truncate">Thread thr_57na</span></a>.</li></ul>`;
    expect(htmlToMarkdown(html)).toBe("- see `thr_57navi8ds7`.");
  });

  it("keeps the spaces around space-wrapped inline code", () => {
    expect(htmlToMarkdown("<p><code> foo </code></p>")).toBe("`  foo  `");
  });

  it("numbers ordered lists from their start attribute", () => {
    expect(htmlToMarkdown(`<ol start="3"><li>three</li><li>four</li></ol>`)).toBe("3. three\n4. four");
  });

  it("indents nested lists under their parent item, without loosening the outer list", () => {
    const html = `<ul><li>outer<ul><li>inner</li></ul></li><li>next</li></ul>`;
    expect(htmlToMarkdown(html)).toBe("- outer\n  - inner\n- next");
  });

  it("separates paragraphs and headings with blank lines", () => {
    expect(htmlToMarkdown(`<h2>Title</h2><p>one</p><p>two</p>`)).toBe("## Title\n\none\n\ntwo");
  });

  it("keeps code blocks verbatim, with their language, and skips copy buttons", () => {
    const html = `<div><button>Copy</button><pre><code class="language-ts">const a = 1;\n\nconst b = "*x*";\n</code></pre></div>`;
    expect(htmlToMarkdown(html)).toBe('```ts\nconst a = 1;\n\nconst b = "*x*";\n```');
  });

  it("picks a fence longer than any backtick run in the code, indented ones included", () => {
    expect(htmlToMarkdown("<pre><code>  ```\nx</code></pre>")).toBe("````\n  ```\nx\n````");
  });

  it("leaves consecutive blank lines inside code alone", () => {
    expect(htmlToMarkdown(`<pre><code>a = """\n\n\n"""</code></pre>`)).toBe('```\na = """\n\n\n"""\n```');
  });

  it("indents a code block under its list item, and quotes it inside a blockquote", () => {
    expect(htmlToMarkdown(`<ol><li><pre><code>x\n\ny</code></pre></li></ol>`)).toBe("1. ```\n   x\n\n   y\n   ```");
    expect(htmlToMarkdown(`<blockquote><pre><code>x\n\ny</code></pre></blockquote>`)).toBe("> ```\n> x\n>\n> y\n> ```");
  });

  it("escapes prose that would otherwise open a heading, quote, list or rule", () => {
    expect(htmlToMarkdown(`<p># not a heading</p>`)).toBe("\\# not a heading");
    expect(htmlToMarkdown(`<p>&gt; not a quote</p>`)).toBe("\\> not a quote");
    expect(htmlToMarkdown(`<p>- not a list</p><p>2024. a year</p><p>---</p>`)).toBe(
      "\\- not a list\n\n2024\\. a year\n\n\\---",
    );
    expect(htmlToMarkdown(`<p>one<br>+ two</p>`)).toBe("one  \n\\+ two");
  });

  it("keeps http links and drops script ones to their text", () => {
    const html = `<p><a href="https://example.com/a b">docs</a> and <a href="javascript:alert(1)">this</a></p>`;
    expect(htmlToMarkdown(html)).toBe("[docs](https://example.com/a%20b) and this");
    expect(htmlToMarkdown(`<p><a href="https://example.com/a)b">x</a></p>`)).toBe("[x](https://example.com/a%29b)");
  });

  it("escapes prose characters that would become markup, but not intra-word underscores", () => {
    expect(htmlToMarkdown(`<p>a * b [c] thr_abc _x_</p>`)).toBe("a \\* b \\[c\\] thr_abc \\_x\\_");
  });

  it("converts blockquotes and tables", () => {
    expect(htmlToMarkdown(`<blockquote><p>quoted</p></blockquote>`)).toBe("> quoted");
    const table = `<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>x|y</td></tr></table>`;
    expect(htmlToMarkdown(table)).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |");
    const code = `<table><tr><th>c</th></tr><tr><td><pre><code>x\ny</code></pre></td></tr></table>`;
    expect(htmlToMarkdown(code)).toBe("| c |\n| --- |\n| `x y` |");
  });

  it("returns null for HTML without block structure, so the plain-text paste runs", () => {
    expect(htmlToMarkdown("")).toBeNull();
    expect(htmlToMarkdown(`<span style="color:red">just a phrase</span>`)).toBeNull();
    // A code editor's copy: styled divs and spans, no markdown-shaped blocks.
    expect(htmlToMarkdown(`<div><div><span>const a = 1;</span></div></div>`)).toBeNull();
  });

  it("ignores the normal-weight <b> wrapper Google Docs puts around a selection", () => {
    expect(htmlToMarkdown(`<b style="font-weight:normal;"><p>plain</p></b>`)).toBe("plain");
  });
});
