import { BRIDGE_VERSION } from "./bridge";

/** The Brain app kit. The frame's policy forbids it fetching a stylesheet or
 *  a script of its own, so the kit is a string this module splices into the
 *  entry at serve time, where the entry asks for it with
 *  `<link rel="brain-kit">`.
 *
 *  The class names are Brain's own, so an app that uses them and the shell
 *  around it are describing the same four registers and the same five
 *  controls. Every value is a token, never a colour: the host hands the
 *  computed properties over at `hello` and again on every theme change, and
 *  the lint refuses an entry that wrote one of its own before it is served. */
export const APP_KIT_CSS = `
/* Brain app kit. Every value is a token the host hands the frame at hello and
   again on every theme change, so a theme flip repaints the app with no
   reload and no second palette. An app that writes a colour of its own is
   refused by the lint before it is ever served. */
:root {
  color-scheme: light dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-sf);
  -webkit-font-smoothing: antialiased;
}
.text-title { font-size: 30px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; }
.text-body { font-size: 16px; font-weight: 400; line-height: 1.5; letter-spacing: -0.2px; }
.text-caption { font-size: 12px; font-weight: 400; line-height: 1.35; color: var(--ink-3); }
.text-label { font-size: 11px; font-weight: 600; line-height: 18px; letter-spacing: 0.06px; color: var(--ink-3); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 44px; padding: 0 16px;
  border: 0; border-radius: var(--r-md);
  background: var(--fill-tint); color: var(--ink);
  font: inherit; font-size: 13px; font-weight: 500;
  cursor: pointer;
  transition: background-color 160ms var(--ease-out);
}
.btn:hover { background: var(--fill-hover); }
.btn[data-primary] { background: var(--ink); color: var(--paper); }
.btn:disabled { opacity: 0.4; pointer-events: none; }
.field {
  display: block; width: 100%; min-height: 44px; padding: 0 12px;
  border: 1px solid var(--hair-strong); border-radius: var(--r-md);
  background: var(--paper); color: var(--ink); font: inherit; font-size: 16px;
}
.field:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px;
  border-radius: var(--r-md); background: var(--fill-tint);
  font-size: 13px; font-weight: 600;
}
.card {
  padding: 16px; border-radius: var(--r-lg);
  background: var(--surface); color: var(--ink);
}
.row {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px; padding: 0 10px;
  border-radius: var(--r-md);
  font-size: 14px;
}
.row:hover { background: var(--fill-hover); }
.row + .row { border-top: 1px solid var(--hair); }
`;

/** THE KIT'S OWN HALF OF THE BRIDGE.
 *
 *  A string, because the frame's policy forbids it fetching a script of its
 *  own, and interpolated from `BRIDGE_VERSION` rather than carrying a literal
 *  `1`: a version that lives in two places parts company at the first bump
 *  with nothing going red.
 *
 *  `hello` is RETRIED until answered. The frame's script runs on load, and
 *  the host's listener is installed by a React effect that runs after it, so
 *  the first hello can genuinely arrive at nobody. One unanswered hello would
 *  leave the app with no tokens and no theme, painted in the browser's
 *  defaults for the life of the page, and it would look like the kit was
 *  broken rather than early.
 *
 *  The retry is a `setTimeout` chained from each attempt rather than an
 *  interval, so nothing keeps firing after the answer lands and a slow host
 *  cannot stack attempts on top of one another.
 *
 *  A theme event carries the tokens with it, so the ordinary repaint costs
 *  the event and nothing else. The `hello` in that branch is the fallback for
 *  a host that sent the theme alone: the token VALUES are what change across
 *  a flip, and an app that kept the old ones would paint a light palette on a
 *  dark ground. */
export const APP_KIT_JS = `
(function () {
  var HELLO_RETRY_MS = 50;
  var HELLO_GIVE_UP_MS = 5000;
  var pending = new Map();
  var next = 0;
  function post(type, payload, rid) {
    parent.postMessage(Object.assign({ v: ${BRIDGE_VERSION}, rid: rid, type: type }, payload || {}), "*");
  }
  function ask(type, payload) {
    var rid = "k" + (next += 1);
    return new Promise(function (resolve, reject) {
      pending.set(rid, { resolve: resolve, reject: reject });
      post(type, payload, rid);
    });
  }
  function applyTokens(tokens) {
    var root = document.documentElement;
    for (var name in tokens) root.style.setProperty(name, tokens[name]);
  }
  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }
  function applyHello(hello) {
    applyTokens((hello && hello.kit && hello.kit.tokens) || {});
    applyTheme(hello && hello.theme);
    return hello;
  }
  function hello() {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      var settled = false;
      function attempt() {
        if (settled) return;
        if (Date.now() - started > HELLO_GIVE_UP_MS) {
          settled = true;
          reject(new Error("Brain did not answer"));
          return;
        }
        ask("hello").then(function (answer) {
          if (settled) return;
          settled = true;
          resolve(applyHello(answer));
        }, function () {});
        setTimeout(attempt, HELLO_RETRY_MS);
      }
      attempt();
    });
  }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.v !== ${BRIDGE_VERSION}) return;
    if (message.event === "theme") {
      applyTheme(message.theme);
      if (message.tokens) applyTokens(message.tokens);
      else ask("hello").then(applyHello, function () {});
      window.dispatchEvent(new CustomEvent("brain:theme", { detail: message.theme }));
      return;
    }
    if (message.event === "visibility") {
      window.dispatchEvent(new CustomEvent("brain:visibility", { detail: message.visible }));
      return;
    }
    var waiting = pending.get(message.rid);
    if (!waiting) return;
    pending.delete(message.rid);
    if (message.ok) waiting.resolve(message.data);
    else waiting.reject(Object.assign(new Error(message.error), { reason: message.reason }));
  });
  window.brain = {
    ready: hello(),
    readTree: function () { return ask("read.tree"); },
    readPage: function (id) { return ask("read.page", { id: id }); },
    readPages: function (query) { return ask("read.pages", { query: query }); },
    writePage: function (id, markdown, rev) { return ask("write.page", { id: id, markdown: markdown, rev: rev }); },
    createPage: function (title, markdown, icon) { return ask("create.page", { title: title, markdown: markdown || "", icon: icon }); },
    getState: function () { return ask("state.get"); },
    setState: function (json) { return ask("state.set", { json: json }); },
    open: function (id) { return ask("open", { id: id }); },
    toast: function (text) { return ask("toast", { text: text }); },
    on: function (name, handler) {
      window.addEventListener("brain:" + name, function (event) { handler(event.detail); });
    }
  };
})();
`;

const KIT_LINK = /<link\s+rel=["']brain-kit["']\s*\/?>/i;

export function injectAppKit(html: string): string {
  if (!KIT_LINK.test(html)) return html;
  return html.replace(
    KIT_LINK,
    `<style>${APP_KIT_CSS}</style><script>${APP_KIT_JS}</script>`,
  );
}
