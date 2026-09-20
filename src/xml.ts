/**
 * A small namespace-aware XML reader, enough for WebDAV multistatus responses. Workers have no
 * `DOMParser`, and WebDAV needs nothing beyond elements, namespaces, text, CDATA, and the standard
 * entities. DTDs are rejected rather than interpreted, so there is no entity-expansion surface.
 */

import { CalDavError } from "./errors";

export const DAV_NS = "DAV:";
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
export const APPLE_ICAL_NS = "http://apple.com/ns/ical/";

export type XmlElement = {
  ns: string;
  name: string;
  /** Non-namespace attributes by their name as written (prefixes are not resolved). */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data directly inside this element. */
  text: string;
};

function malformed(detail: string): CalDavError {
  return new CalDavError("UPSTREAM_UNAVAILABLE", `The server returned malformed XML: ${detail}`);
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

type Frame = { element: XmlElement; namespaces: Map<string, string> };

/** Parses an XML document and returns its root element. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { ns: "", name: "#document", attrs: {}, children: [], text: "" };
  const stack: Frame[] = [{ element: root, namespaces: new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]) }];
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    const top = stack[stack.length - 1];
    if (lt === -1) {
      top.element.text += decodeEntities(source.slice(index));
      break;
    }
    if (lt > index) top.element.text += decodeEntities(source.slice(index, lt));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      if (end === -1) throw malformed("unterminated comment");
      index = end + 3;
    } else if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      if (end === -1) throw malformed("unterminated CDATA");
      top.element.text += source.slice(lt + 9, end);
      index = end + 3;
    } else if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt);
      if (end === -1) throw malformed("unterminated processing instruction");
      index = end + 2;
    } else if (source.startsWith("<!", lt)) {
      throw malformed("DOCTYPE declarations are not accepted");
    } else if (source.startsWith("</", lt)) {
      const end = source.indexOf(">", lt);
      if (end === -1) throw malformed("unterminated end tag");
      if (stack.length === 1) throw malformed("unbalanced end tag");
      stack.pop();
      index = end + 1;
    } else {
      // Find the tag's end, skipping '>' inside quoted attribute values.
      let end = lt + 1;
      let quote: string | null = null;
      for (; end < source.length; end++) {
        const char = source[end];
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === "\"" || char === "'") quote = char;
        else if (char === ">") break;
      }
      if (end >= source.length) throw malformed("unterminated start tag");
      const selfClosing = source[end - 1] === "/";
      const body = source.slice(lt + 1, selfClosing ? end - 1 : end);
      const nameMatch = /^[^\s/>]+/.exec(body);
      if (!nameMatch) throw malformed("empty tag name");
      const qualified = nameMatch[0];

      const namespaces = new Map(top.namespaces);
      const attrs: Record<string, string> = {};
      for (const match of body.slice(qualified.length).matchAll(ATTRIBUTE_RE)) {
        const attribute = match[1];
        const value = decodeEntities(match[2] ?? match[3] ?? "");
        if (attribute === "xmlns") namespaces.set("", value);
        else if (attribute.startsWith("xmlns:")) namespaces.set(attribute.slice(6), value);
        else attrs[attribute] = value;
      }
      const colon = qualified.indexOf(":");
      const prefix = colon === -1 ? "" : qualified.slice(0, colon);
      const element: XmlElement = {
        ns: namespaces.get(prefix) ?? "",
        name: colon === -1 ? qualified : qualified.slice(colon + 1),
        attrs,
        children: [],
        text: "",
      };
      top.element.children.push(element);
      if (!selfClosing) stack.push({ element, namespaces });
      index = end + 1;
    }
  }
  if (stack.length !== 1) throw malformed("unclosed elements");
  const documentElement = root.children[0];
  if (!documentElement) throw malformed("no root element");
  return documentElement;
}

export function child(element: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return element?.children.find(candidate => candidate.ns === ns && candidate.name === name);
}

export function children(element: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return element?.children.filter(candidate => candidate.ns === ns && candidate.name === name) ?? [];
}

export type MultistatusResponse = {
  href: string;
  /** Properties from every 2xx propstat, keyed by `${ns}|${name}`. */
  props: Map<string, XmlElement>;
  /** Status of the response itself, when the server reports one instead of propstats. */
  status?: number;
};

function parseStatus(text: string | undefined): number | undefined {
  const match = /HTTP\/[\d.]+\s+(\d{3})/.exec(text ?? "");
  return match ? Number(match[1]) : undefined;
}

export function propKey(ns: string, name: string): string {
  return `${ns}|${name}`;
}

/** Reads a `DAV:multistatus` document into one entry per `DAV:response`. */
export function parseMultistatus(source: string): MultistatusResponse[] {
  const root = parseXml(source);
  if (root.ns !== DAV_NS || root.name !== "multistatus") throw malformed("expected a DAV:multistatus");
  return children(root, DAV_NS, "response").map(response => {
    const href = child(response, DAV_NS, "href")?.text.trim() ?? "";
    const props = new Map<string, XmlElement>();
    for (const propstat of children(response, DAV_NS, "propstat")) {
      const status = parseStatus(child(propstat, DAV_NS, "status")?.text);
      if (status !== undefined && (status < 200 || status >= 300)) continue;
      for (const prop of child(propstat, DAV_NS, "prop")?.children ?? []) props.set(propKey(prop.ns, prop.name), prop);
    }
    return { href, props, status: parseStatus(child(response, DAV_NS, "status")?.text) };
  });
}
