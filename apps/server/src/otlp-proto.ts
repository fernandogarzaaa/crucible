import type { OtlpExportRequest } from "./otlp.js";

/**
 * Minimal protobuf wire-format decoder for OTLP ExportTraceServiceRequest. The schema is small and
 * stable, so a hand-written reader avoids a protobuf runtime dependency. It produces the same JSON
 * shape the OTLP/JSON path consumes (hex ids, nanosecond strings, {key, value:{stringValue}} attrs).
 */

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}
  get eof() { return this.pos >= this.buf.length; }
  varint(): bigint {
    let result = 0n, shift = 0n;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("protobuf: varint too long");
    }
  }
  fixed64(): bigint {
    if (this.pos + 8 > this.buf.length) throw new Error("protobuf: truncated fixed64");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8; return v;
  }
  fixed32(): number {
    if (this.pos + 4 > this.buf.length) throw new Error("protobuf: truncated fixed32");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4; return v;
  }
  double(): number {
    if (this.pos + 8 > this.buf.length) throw new Error("protobuf: truncated double");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8; return v;
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.length) throw new Error("protobuf: truncated bytes");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len; return out;
  }
  string(): string { return new TextDecoder().decode(this.bytes()); }
  /** Iterate fields: yields [fieldNumber, wireType]; caller must consume the value via the matching reader. */
  *fields(): Generator<[number, number]> {
    while (!this.eof) {
      const tag = Number(this.varint());
      yield [tag >>> 3, tag & 7];
    }
  }
  skip(wireType: number) {
    switch (wireType) {
      case 0: this.varint(); break;
      case 1: this.fixed64(); break;
      case 2: this.bytes(); break;
      case 5: this.fixed32(); break;
      default: throw new Error(`protobuf: unsupported wire type ${wireType}`);
    }
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const toSigned64 = (u: bigint) => (u >= 1n << 63n ? u - (1n << 64n) : u);

type AnyValue = { stringValue?: string; boolValue?: boolean; intValue?: string; doubleValue?: number; arrayValue?: { values: AnyValue[] }; kvlistValue?: { values: Array<{ key: string; value: AnyValue }> }; bytesValue?: string };

function anyValue(buf: Uint8Array): AnyValue {
  const r = new Reader(buf);
  const out: AnyValue = {};
  for (const [f, w] of r.fields()) {
    switch (f) {
      case 1: out.stringValue = r.string(); break;
      case 2: out.boolValue = r.varint() !== 0n; break;
      case 3: out.intValue = toSigned64(r.varint()).toString(); break;
      case 4: out.doubleValue = r.double(); break;
      case 5: out.arrayValue = { values: repeated(r.bytes(), 1).map(anyValue) }; break;
      case 6: out.kvlistValue = { values: repeated(r.bytes(), 1).map(keyValue) }; break;
      case 7: out.bytesValue = Buffer.from(r.bytes()).toString("base64"); break;
      default: r.skip(w);
    }
  }
  return out;
}
/** Collect all length-delimited occurrences of `field` in a message. */
function repeated(buf: Uint8Array, field: number): Uint8Array[] {
  const r = new Reader(buf); const out: Uint8Array[] = [];
  for (const [f, w] of r.fields()) { if (f === field && w === 2) out.push(r.bytes()); else r.skip(w); }
  return out;
}
function keyValue(buf: Uint8Array): { key: string; value: AnyValue } {
  const r = new Reader(buf); let key = ""; let value: AnyValue = {};
  for (const [f, w] of r.fields()) { if (f === 1) key = r.string(); else if (f === 2) value = anyValue(r.bytes()); else r.skip(w); }
  return { key, value };
}
function attributes(buf: Uint8Array, field: number) { return repeated(buf, field).map(keyValue); }

function span(buf: Uint8Array) {
  const r = new Reader(buf);
  const s: Record<string, unknown> = { attributes: [], events: [] };
  for (const [f, w] of r.fields()) {
    switch (f) {
      case 1: s.traceId = hex(r.bytes()); break;
      case 2: s.spanId = hex(r.bytes()); break;
      case 3: s.traceState = r.string(); break;
      case 4: s.parentSpanId = hex(r.bytes()); break;
      case 5: s.name = r.string(); break;
      case 6: s.kind = Number(r.varint()); break;
      case 7: s.startTimeUnixNano = r.fixed64().toString(); break;
      case 8: s.endTimeUnixNano = r.fixed64().toString(); break;
      case 9: (s.attributes as unknown[]).push(keyValue(r.bytes())); break;
      case 11: { const e = new Reader(r.bytes()); const ev: Record<string, unknown> = { attributes: [] };
        for (const [ef, ew] of e.fields()) { if (ef === 1) ev.timeUnixNano = e.fixed64().toString(); else if (ef === 2) ev.name = e.string(); else if (ef === 3) (ev.attributes as unknown[]).push(keyValue(e.bytes())); else e.skip(ew); }
        (s.events as unknown[]).push(ev); break; }
      case 15: { const st = new Reader(r.bytes()); const status: Record<string, unknown> = {};
        for (const [sf, sw] of st.fields()) { if (sf === 2) status.message = st.string(); else if (sf === 3) status.code = Number(st.varint()); else st.skip(sw); }
        s.status = status; break; }
      default: r.skip(w);
    }
  }
  return s;
}

export function decodeExportTraceServiceRequest(buf: Uint8Array): OtlpExportRequest {
  const resourceSpans: NonNullable<OtlpExportRequest["resourceSpans"]> = [];
  for (const rsBuf of repeated(buf, 1)) {
    const rs = new Reader(rsBuf);
    const entry: NonNullable<OtlpExportRequest["resourceSpans"]>[number] = { scopeSpans: [] };
    for (const [f, w] of rs.fields()) {
      if (f === 1) entry.resource = { attributes: attributes(rs.bytes(), 1) };
      else if (f === 2) {
        const ss = new Reader(rs.bytes());
        const scope: NonNullable<typeof entry.scopeSpans>[number] = { spans: [] };
        for (const [sf, sw] of ss.fields()) {
          if (sf === 1) { const sc = new Reader(ss.bytes()); const meta: { name?: string; version?: string } = {}; for (const [cf, cw] of sc.fields()) { if (cf === 1) meta.name = sc.string(); else if (cf === 2) meta.version = sc.string(); else sc.skip(cw); } scope.scope = meta; }
          else if (sf === 2) scope.spans!.push(span(ss.bytes()) as never);
          else if (sf === 3) scope.schemaUrl = ss.string();
          else ss.skip(sw);
        }
        entry.scopeSpans!.push(scope);
      } else if (f === 3) { rs.string(); } else rs.skip(w);
    }
    resourceSpans.push(entry);
  }
  return { resourceSpans };
}
