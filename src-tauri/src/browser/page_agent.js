/*
 * E.V's page agent: runs inside a web page (through the browser's own scripting, or the E.V
 * extension) and answers one request at a time with a JSON string.
 *
 *   look  {find?, text?, limit?}   numbered controls with their labels and current state
 *   about {actions}                what each action would touch (E.V checks sends and deletes first)
 *   do    {actions}                runs them in order, stops at the first one that fails
 *   diff  {}                       what changed since the last look or do
 *
 * Controls keep their number (data-ev) for as long as the page lives, so a look, then a batch of
 * actions, then a diff all speak about the same things. The script only ever does what one request
 * says; it never sends anything anywhere.
 */
(function () {
  "use strict";
  var VERSION = 4;
  if (window.__evAgent && window.__evAgent.version === VERSION) return;

  var state = (window.__evState = window.__evState || { next: 1, before: null });

  var INTERACTIVE_ROLES = {
    button: "Button", link: "Link", checkbox: "CheckBox", radio: "Radio", switch: "Switch", tab: "Tab",
    menuitem: "MenuItem", menuitemcheckbox: "MenuItem", menuitemradio: "MenuItem", option: "Option",
    combobox: "ComboBox", listbox: "List", slider: "Slider", spinbutton: "Number", textbox: "TextField",
    searchbox: "SearchField", treeitem: "TreeItem", gridcell: "Cell",
  };

  function clean(text, max) {
    // Icon fonts draw pictures with private-use characters: they read as nothing.
    var t = String(text == null ? "" : text).replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, " ").replace(/\s+/g, " ").trim();
    return max && t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function styleOf(el) {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  function visible(el) {
    var s = styleOf(el);
    if (!s || s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || Number(s.opacity) === 0) return false;
    if (el.closest && el.closest("[hidden],[aria-hidden='true'],[inert]")) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      // A styled checkbox or radio is often hidden behind its label: it still counts.
      return el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type || "");
    }
    return true;
  }

  function onScreen(el) {
    var r = el.getBoundingClientRect();
    var win = el.ownerDocument.defaultView;
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  }

  function roleOf(el) {
    var aria = (el.getAttribute("role") || "").toLowerCase().split(" ")[0];
    if (INTERACTIVE_ROLES[aria]) return INTERACTIVE_ROLES[aria];
    var tag = el.tagName;
    if (tag === "A") return "Link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "Button";
    if (tag === "SELECT") return "PopUp";
    if (tag === "TEXTAREA") return "TextArea";
    if (tag === "INPUT") {
      var type = (el.type || "text").toLowerCase();
      if (type === "checkbox") return "CheckBox";
      if (type === "radio") return "Radio";
      if (type === "range") return "Slider";
      if (type === "color") return "ColorWell";
      if (type === "number") return "Number";
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "Button";
      if (type === "search") return "SearchField";
      if (type === "file") return "FileButton";
      return "TextField";
    }
    if (el.isContentEditable) return "TextArea";
    return "Clickable";
  }

  function isInteractive(el) {
    var tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") || el.hasAttribute("onclick");
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
    if (tag === "INPUT") return (el.type || "").toLowerCase() !== "hidden";
    var role = (el.getAttribute("role") || "").toLowerCase().split(" ")[0];
    if (INTERACTIVE_ROLES[role]) return true;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    var tab = el.getAttribute("tabindex");
    if (tab !== null && Number(tab) >= 0 && el.textContent && el.textContent.trim()) return true;
    // Many sites (and settings panels) make plain text clickable: a pointer cursor on an element
    // whose parent doesn't have one marks where the click target starts.
    var s = styleOf(el);
    if (s && s.cursor === "pointer") {
      var parent = el.parentElement;
      var ps = parent ? styleOf(parent) : null;
      if (!ps || ps.cursor !== "pointer") return true;
    }
    return false;
  }

  function textById(doc, ids) {
    return ids
      .split(/\s+/)
      .map(function (id) {
        var n = id && doc.getElementById(id);
        return n ? n.textContent : "";
      })
      .join(" ");
  }

  function ownLabel(el) {
    var doc = el.ownerDocument;
    var v = el.getAttribute("aria-label");
    if (v && v.trim()) return v;
    v = el.getAttribute("aria-labelledby");
    if (v) {
      var byId = textById(doc, v);
      if (byId.trim()) return byId;
    }
    if (el.labels && el.labels.length) {
      var labelText = Array.prototype.map.call(el.labels, function (l) { return l.textContent; }).join(" ");
      if (labelText.trim()) return labelText;
    }
    var tag = el.tagName;
    if (tag === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) return el.value;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      v = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name");
      if (v) return v;
    }
    if (tag === "IMG") return el.alt || el.title;
    if (tag !== "SELECT" && tag !== "INPUT" && tag !== "TEXTAREA") {
      // innerText skips words hidden until hover (menus that expand); the words still name it.
      var text = clean(el.innerText) ? el.innerText : el.textContent || "";
      if (clean(text)) return text;
      var img = el.querySelector && el.querySelector("img[alt],svg title,[aria-label]");
      if (img) return img.getAttribute("alt") || img.getAttribute("aria-label") || img.textContent;
    }
    return el.getAttribute("title") || "";
  }

  // An unnamed icon still says something in its id, data or class ("scrHide" → "scr hide").
  function hintOf(el) {
    var raw = el.id || el.getAttribute("data") || el.getAttribute("data-action") || el.getAttribute("name") || (el.className && typeof el.className === "string" ? el.className.split(/\s+/).filter(function (c) { return c && c.length > 2 && !/^(on|off|active|enable|disabled?)$/.test(c); })[0] : "") || "";
    return clean(String(raw).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " "), 30);
  }

  // Settings pages put the words beside the control ("Timer color  [■]"): the nearest row's own
  // text, minus the control's, names it.
  function contextLabel(el) {
    var node = el.parentElement;
    for (var depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      var t = clean(node.innerText || node.textContent || "", 160);
      var isBox = el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type || "");
      var own = isBox ? "" : clean(el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : el.innerText, 160);
      if (own.length >= 2) t = clean(t.split(own).join(" "), 160);
      if (t && t.length >= 2) {
        if (t.length <= 80) return t;
        if (node.tagName === "TR" || node.tagName === "LI" || node.tagName === "LABEL") return clean(t, 80);
      }
      if (node.tagName === "TR" || node.tagName === "LI" || node.tagName === "FORM" || node.tagName === "SECTION") break;
    }
    return "";
  }

  function inDialog(el) {
    return Boolean(el.closest && el.closest("dialog,[role='dialog'],[role='alertdialog'],[aria-modal='true']"));
  }

  function stateOf(el, role) {
    var parts = [];
    var tag = el.tagName;
    if (tag === "INPUT" && /^(checkbox|radio)$/i.test(el.type)) parts.push(el.checked ? "on" : "off");
    var ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked && !(tag === "INPUT")) parts.push(ariaChecked === "true" ? "on" : ariaChecked === "mixed" ? "mixed" : "off");
    var pressed = el.getAttribute("aria-pressed");
    if (pressed) parts.push(pressed === "true" ? "pressed" : "not pressed");
    var selected = el.getAttribute("aria-selected");
    if (selected === "true") parts.push("selected");
    var expanded = el.getAttribute("aria-expanded");
    if (expanded) parts.push(expanded === "true" ? "open" : "closed");
    if (tag === "SELECT") {
      var opt = el.options[el.selectedIndex];
      parts.push("= " + JSON.stringify(clean(opt ? opt.text : "", 40)));
      var names = Array.prototype.slice.call(el.options, 0, 14).map(function (o) { return clean(o.text, 24); });
      parts.push("options: " + names.join(" | ") + (el.options.length > 14 ? " | …" + (el.options.length - 14) + " more" : ""));
    } else if (tag === "INPUT" || tag === "TEXTAREA") {
      var type = (el.type || "").toLowerCase();
      if (type === "password") parts.push("password field");
      else if (!/^(checkbox|radio|submit|button|reset|image|file)$/.test(type)) parts.push("= " + JSON.stringify(clean(el.value, 60)));
      if (type === "range" || type === "number") {
        if (el.min !== "") parts.push("min " + el.min);
        if (el.max !== "") parts.push("max " + el.max);
      }
    } else if (role === "TextArea" && el.isContentEditable) {
      parts.push("= " + JSON.stringify(clean(el.innerText, 60)));
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.ownerDocument.activeElement === el) parts.push("focused");
    return parts.join(", ");
  }

  function refOf(el) {
    var ref = el.getAttribute("data-ev");
    if (!ref) {
      ref = String(state.next++);
      el.setAttribute("data-ev", ref);
    }
    return Number(ref);
  }

  // Every document the page shows: the page itself, open shadow roots and same-site frames.
  function roots() {
    var out = [document];
    for (var i = 0; i < out.length && out.length < 60; i++) {
      var root = out[i];
      var all = root.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) {
        var n = all[j];
        if (n.shadowRoot) out.push(n.shadowRoot);
        if (n.tagName === "IFRAME" || n.tagName === "FRAME") {
          try {
            if (n.contentDocument && visible(n)) out.push(n.contentDocument);
          } catch (e) {}
        }
      }
    }
    return out;
  }

  function collect() {
    var found = [];
    var seen = new Set();
    roots().forEach(function (root) {
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (seen.has(el) || !isInteractive(el) || !visible(el)) continue;
        // A clickable inside a clickable (an icon in a button) is the same target.
        var outer = el.parentElement && el.parentElement.closest("a[href],button,[role='button'],[role='link'],[role='menuitem'],[role='option'],[role='tab']");
        if (outer && seen.has(outer) && roleOf(el) === "Clickable") continue;
        seen.add(el);
        found.push(el);
      }
    });
    return found;
  }

  function describe(el) {
    var role = roleOf(el);
    var label = clean(ownLabel(el), 90);
    var near = role === "Clickable" && label.length > 40 ? "" : contextLabel(el);
    if (near && label && near.toLowerCase().indexOf(label.toLowerCase()) !== -1 && near.length <= label.length + 2) near = "";
    var hint = !label && !near ? hintOf(el) : "";
    var href = el.tagName === "A" && el.href && !/^javascript:/i.test(el.href) ? el.href : "";
    return {
      id: refOf(el),
      role: role,
      label: label,
      near: near,
      hint: hint,
      state: stateOf(el, role),
      url: href,
      offscreen: !onScreen(el),
      dialog: inDialog(el),
    };
  }

  function line(c) {
    var s = "#" + c.id + " " + c.role;
    if (c.label) s += ' "' + c.label.replace(/"/g, "'") + '"';
    if (c.near) s += " [" + c.near + "]";
    if (c.hint) s += " {" + c.hint + "}";
    if (c.state) s += " (" + c.state + ")";
    if (c.url) s += " → " + c.url.replace(/^https?:\/\//, "").slice(0, 70);
    if (c.offscreen) s += " (off screen)";
    if (c.dialog) s += " (in dialog)";
    return s;
  }

  function stem(w) {
    w = w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    return w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w;
  }

  function matcher(find) {
    var words = String(find || "").split(/[\s,]+/).map(stem).filter(function (w) { return w.length > 1; });
    if (!words.length) return null;
    return function (c) {
      var hay = " " + [c.role, c.label, c.near, c.state, c.url].join(" ").split(/[^\p{L}\p{N}]+/u).map(stem).join(" ") + " ";
      return words.some(function (w) { return hay.indexOf(w) !== -1; });
    };
  }

  // What a control is and says, without where it sits (scrolling isn't a change).
  function snapshot(list) {
    var map = {};
    var shown = {};
    list.forEach(function (c) {
      map[c.id] = line(Object.assign({}, c, { offscreen: false }));
      shown[c.id] = line(c);
    });
    return { url: location.href, title: document.title, lines: map, shown: shown };
  }

  function look(req) {
    var all = collect().map(describe);
    state.before = snapshot(all);
    var match = matcher(req.find);
    var kept = match ? all.filter(match) : all;
    var limit = Math.max(20, Math.min(Number(req.limit) || 200, 800));
    var out = {
      title: document.title,
      url: location.href,
      total: all.length,
      shown: Math.min(kept.length, limit),
      matching: match ? kept.length : undefined,
      controls: kept.slice(0, limit).map(line),
    };
    if (req.text) {
      var body = document.body ? document.body.innerText || "" : "";
      out.text = clean(body, Math.max(500, Math.min(Number(req.textLimit) || 6000, 20000)));
    }
    return out;
  }

  function byRef(ref) {
    var want = String(ref);
    var hit = null;
    roots().some(function (root) {
      hit = root.querySelector('[data-ev="' + want.replace(/"/g, "") + '"]');
      return Boolean(hit);
    });
    return hit;
  }

  // A control by its words, for saved routes (numbers change between visits): its own label
  // first, then the words beside it; the role narrows it when given.
  function byLabel(label, role) {
    var want = clean(label).toLowerCase();
    if (!want) return null;
    var list = collect().map(function (el) { return { el: el, c: describe(el) }; });
    var fits = function (x) { return !role || x.c.role.toLowerCase() === String(role).toLowerCase(); };
    var exact = list.filter(function (x) { return fits(x) && x.c.label.toLowerCase() === want; });
    if (!exact.length) exact = list.filter(function (x) { return fits(x) && x.c.near.toLowerCase() === want; });
    if (!exact.length) exact = list.filter(function (x) { return fits(x) && (x.c.label + " " + x.c.near).toLowerCase().indexOf(want) !== -1; });
    return exact.length ? exact[0].el : null;
  }

  function target(a) {
    if (a.ref !== undefined && a.ref !== null) return byRef(a.ref);
    if (a.label) return byLabel(a.label, a.role);
    return document.activeElement;
  }

  function about(req) {
    return {
      url: location.href,
      actions: (req.actions || []).map(function (a) {
        if (a.do === "wait") return { do: "wait" };
        var el = target(a);
        if (!el) return { do: a.do, missing: true };
        var c = describe(el);
        var type = (el.type || "").toLowerCase();
        var search = type === "search" || /search/i.test([el.getAttribute("role"), el.name, el.placeholder, el.getAttribute("aria-label")].join(" "));
        return { do: a.do, id: c.id, role: c.role, label: c.label || c.near, own: c.label, near: c.near, dialog: c.dialog, password: type === "password", search: search, key: a.key };
      }),
    };
  }

  function fire(el, type, init) {
    var win = el.ownerDocument.defaultView;
    var Ctor = /^pointer/.test(type) && win.PointerEvent ? win.PointerEvent : /^key/.test(type) ? win.KeyboardEvent : /^(mouse|click)/.test(type) ? win.MouseEvent : win.Event;
    el.dispatchEvent(new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: win }, init || {})));
  }

  function press(el) {
    var r = el.getBoundingClientRect();
    var at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    fire(el, "pointerdown", at);
    fire(el, "mousedown", at);
    if (el.focus) el.focus({ preventScroll: true });
    fire(el, "pointerup", at);
    fire(el, "mouseup", at);
    if (typeof el.click === "function") el.click();
    else fire(el, "click", at);
  }

  // Frameworks (React, Vue) watch the element's own value setter; the prototype's one gets through.
  function setValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    fire(el, "input");
    fire(el, "change");
  }

  function pickOption(el, want) {
    var w = String(want).trim().toLowerCase();
    var opts = Array.prototype.slice.call(el.options);
    var hit =
      opts.find(function (o) { return o.text.trim().toLowerCase() === w || o.value.toLowerCase() === w; }) ||
      opts.find(function (o) { return o.text.trim().toLowerCase().indexOf(w) === 0; }) ||
      opts.find(function (o) { return o.text.trim().toLowerCase().indexOf(w) !== -1; });
    if (!hit) throw new Error("no option " + JSON.stringify(want) + " (options: " + opts.slice(0, 20).map(function (o) { return o.text.trim(); }).join(" | ") + ")");
    setValue(el, hit.value);
    return hit.text.trim();
  }

  // A list that isn't a <select> (menus, dropdowns drawn by the page): open it, then pick the option
  // by its words. When the options only appear a moment later, it stays open and the result lists
  // them as new controls to click.
  var OPTION_ROLES = "[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=treeitem]";
  function optionText(o) {
    return clean(o.getAttribute("aria-label") || o.innerText || o.textContent || "", 80).toLowerCase();
  }
  function pickCustom(el, want, name) {
    var w = String(want == null ? "" : want).trim().toLowerCase();
    if (!w) throw new Error("say which option to pick in " + name);
    var isList = el.getAttribute("role") === "listbox";
    if (!isList) press(el);
    var pool = [];
    var owned = (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/);
    owned.forEach(function (id) {
      var root = id && document.getElementById(id);
      if (root) pool = pool.concat(Array.prototype.slice.call(root.querySelectorAll(OPTION_ROLES + ",li,[data-value]")));
    });
    if (isList) pool = pool.concat(Array.prototype.slice.call(el.querySelectorAll(OPTION_ROLES + ",li,[data-value]")));
    pool = pool.concat(Array.prototype.slice.call(document.querySelectorAll(OPTION_ROLES)));
    // Lists drawn right next to the control (no roles): its nearby items.
    var near = el.parentElement && el.parentElement.parentElement;
    if (near) pool = pool.concat(Array.prototype.slice.call(near.querySelectorAll("li,[data-value]")));
    var opts = pool.filter(function (o, i) { return o !== el && !o.contains(el) && pool.indexOf(o) === i && visible(o); });
    var hit =
      opts.find(function (o) { return optionText(o) === w || String(o.getAttribute("data-value") || "").toLowerCase() === w; }) ||
      opts.find(function (o) { return optionText(o).indexOf(w) === 0; }) ||
      opts.find(function (o) { return optionText(o).indexOf(w) !== -1; });
    if (hit) {
      press(hit);
      return "picked " + JSON.stringify(clean(hit.innerText || hit.textContent, 40)) + " in " + name;
    }
    if (isList) throw new Error("no option " + JSON.stringify(want) + " in " + name + " (options: " + opts.slice(0, 15).map(optionText).join(" | ") + ")");
    return "opened " + name + " — " + JSON.stringify(want) + " wasn't listed yet; click it from the new controls below";
  }

  // Popups the page raises (alert / confirm / prompt) freeze it until someone answers, which hangs
  // every later step. While E.V acts, and for a few seconds after, they're answered and noted
  // instead: confirm → Cancel unless the action said confirm: true.
  function holdDialogs() {
    var win = window;
    state.dialogs = state.dialogs || [];
    if (!state.realDialogs) state.realDialogs = { alert: win.alert, confirm: win.confirm, prompt: win.prompt };
    win.alert = function (m) { state.dialogs.push("the page said: " + JSON.stringify(clean(m, 200)) + " (closed)"); };
    win.confirm = function (m) {
      var yes = state.confirmNext === true;
      state.dialogs.push("the page asked: " + JSON.stringify(clean(m, 200)) + " → answered " + (yes ? "OK" : "Cancel") + (yes ? "" : " (to answer OK, repeat the action with confirm: true)"));
      return yes;
    };
    win.prompt = function (m) { state.dialogs.push("the page asked for text: " + JSON.stringify(clean(m, 200)) + " → cancelled"); return null; };
    if (state.dialogTimer) clearTimeout(state.dialogTimer);
    state.dialogTimer = setTimeout(function () {
      var real = state.realDialogs;
      if (real) {
        win.alert = real.alert;
        win.confirm = real.confirm;
        win.prompt = real.prompt;
      }
      state.realDialogs = null;
      state.confirmNext = false;
    }, 4000);
  }

  var KEYS = { enter: ["Enter", 13], return: ["Enter", 13], escape: ["Escape", 27], esc: ["Escape", 27], tab: ["Tab", 9], space: [" ", 32], up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39], backspace: ["Backspace", 8], delete: ["Delete", 46] };

  function act(a) {
    var kind = a.do;
    if (kind === "wait") return "waited";
    var el = target(a);
    if (!el) throw new Error((a.label ? "no control called " + JSON.stringify(a.label) : "#" + a.ref + " isn't on the page any more") + " — look again");
    if (el.scrollIntoView && !onScreen(el)) el.scrollIntoView({ block: "center", inline: "nearest" });
    var name = clean(ownLabel(el) || contextLabel(el), 50) || roleOf(el);
    var type = (el.type || "").toLowerCase();
    switch (kind) {
      case "click":
        press(el);
        return "clicked " + name;
      case "set": {
        if (type === "password") throw new Error("E.V never types into password fields");
        var value = a.value == null ? "" : String(a.value);
        if (el.tagName === "SELECT") return "picked " + JSON.stringify(pickOption(el, value)) + " in " + name;
        if (el.isContentEditable) {
          el.focus();
          el.textContent = value;
          fire(el, "input");
          return "set " + name;
        }
        if (type === "checkbox" || type === "radio") {
          var on = /^(true|on|yes|1|checked)$/i.test(value);
          if (el.checked !== on) press(el);
          return name + " " + (el.checked ? "on" : "off");
        }
        if (el.focus) el.focus({ preventScroll: true });
        setValue(el, value);
        return "set " + name + " to " + JSON.stringify(clean(el.value, 40));
      }
      case "check": {
        var want = a.on !== false;
        var isBox = type === "checkbox" || type === "radio";
        var current = isBox ? el.checked : el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true";
        if (current !== want) press(el);
        return name + " " + (want ? "on" : "off");
      }
      case "select":
        if (el.tagName !== "SELECT") return pickCustom(el, a.option == null ? a.value : a.option, name);
        return "picked " + JSON.stringify(pickOption(el, a.option == null ? a.value : a.option)) + " in " + name;
      case "press": {
        var k = KEYS[String(a.key || "").toLowerCase()] || [String(a.key || ""), 0];
        var init = { key: k[0], code: k[0].length === 1 ? "Key" + k[0].toUpperCase() : k[0], keyCode: k[1], which: k[1] };
        fire(el, "keydown", init);
        fire(el, "keypress", init);
        fire(el, "keyup", init);
        if (k[0] === "Enter" && el.form && el.tagName === "INPUT" && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
        return "pressed " + k[0] + " in " + name;
      }
      case "scroll":
        el.scrollIntoView({ block: "center" });
        return "scrolled to " + name;
      default:
        throw new Error("unknown action " + JSON.stringify(kind));
    }
  }

  function run(req) {
    var done = [];
    var actions = req.actions || [];
    holdDialogs();
    for (var i = 0; i < actions.length; i++) {
      state.confirmNext = actions[i].confirm === true;
      try {
        done.push(act(actions[i]));
      } catch (e) {
        return { done: done, failed: { index: i, error: String((e && e.message) || e) } };
      }
    }
    return { done: done };
  }

  function diff() {
    var now = collect().map(describe);
    var after = snapshot(now);
    var before = state.before;
    state.before = after;
    if (!before) return { url: after.url, title: after.title, changed: [], added: [], removed: 0, total: now.length, dialogs: (state.dialogs || []).splice(0) };
    var changed = [];
    var added = [];
    Object.keys(after.lines).forEach(function (id) {
      if (!(id in before.lines)) added.push(after.shown[id]);
      else if (before.lines[id] !== after.lines[id]) changed.push(after.shown[id]);
    });
    var removed = Object.keys(before.lines).filter(function (id) { return !(id in after.lines); }).length;
    return {
      url: after.url,
      title: after.title,
      navigated: after.url !== before.url,
      changed: changed.slice(0, 60),
      added: added.slice(0, 80),
      moreAdded: Math.max(0, added.length - 80),
      removed: removed,
      total: now.length,
      dialogs: (state.dialogs || []).splice(0),
    };
  }

  window.__evAgent = {
    version: VERSION,
    run: function (req) {
      try {
        var op = req && req.op;
        var out = op === "look" ? look(req) : op === "about" ? about(req) : op === "do" ? run(req) : op === "diff" ? diff() : { error: "unknown op" };
        return JSON.stringify(out);
      } catch (e) {
        return JSON.stringify({ error: String((e && e.message) || e) });
      }
    },
  };
})();
