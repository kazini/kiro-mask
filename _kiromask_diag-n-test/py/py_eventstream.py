#!/usr/bin/env python3
"""Independent AWS event-stream implementation (stdlib only), used to cross-check the Node codec.

  py_eventstream.py decode <file>     -> one JSON object per frame on stdout
  py_eventstream.py encode            -> reads JSON lines on stdin {"type":..., "payload":{...}}, writes frames to stdout
"""
import json, struct, sys, zlib


def decode(data: bytes):
    pos = 0
    while pos < len(data):
        if pos + 12 > len(data):
            raise ValueError("truncated prelude")
        total, hlen, pcrc = struct.unpack(">III", data[pos:pos + 12])
        if zlib.crc32(data[pos:pos + 8]) & 0xFFFFFFFF != pcrc:
            raise ValueError("prelude CRC mismatch")
        if pos + total > len(data):
            raise ValueError("truncated message")
        mcrc = struct.unpack(">I", data[pos + total - 4:pos + total])[0]
        if zlib.crc32(data[pos:pos + total - 4]) & 0xFFFFFFFF != mcrc:
            raise ValueError("message CRC mismatch")
        h, i, hdr = data[pos + 12:pos + 12 + hlen], 0, {}
        while i < len(h):
            n = h[i]; i += 1
            name = h[i:i + n].decode(); i += n
            t = h[i]; i += 1
            if t != 7:
                raise ValueError(f"unsupported header type {t}")
            l = struct.unpack(">H", h[i:i + 2])[0]; i += 2
            hdr[name] = h[i:i + l].decode(); i += l
        payload = data[pos + 12 + hlen:pos + total - 4]
        yield hdr, payload
        pos += total


def encode(event_type: str, payload: dict) -> bytes:
    def hdr(name, value):
        n, v = name.encode(), value.encode()
        return bytes([len(n)]) + n + b"\x07" + struct.pack(">H", len(v)) + v
    headers = hdr(":event-type", event_type) + hdr(":content-type", "application/json") + hdr(":message-type", "event")
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    total = 12 + len(headers) + len(body) + 4
    prelude = struct.pack(">II", total, len(headers))
    out = prelude + struct.pack(">I", zlib.crc32(prelude) & 0xFFFFFFFF) + headers + body
    return out + struct.pack(">I", zlib.crc32(out) & 0xFFFFFFFF)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "decode":
        for hdr, payload in decode(open(sys.argv[2], "rb").read()):
            print(json.dumps({"type": hdr.get(":event-type"), "payload": json.loads(payload) if payload else None}, ensure_ascii=False))
    elif cmd == "encode":
        for line in sys.stdin:
            if line.strip():
                o = json.loads(line)
                sys.stdout.buffer.write(encode(o["type"], o["payload"]))
    else:
        sys.exit("unknown command")
