import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseText } from "../../packages/collection/src/http-transport.js";

describe("bounded HTTP response reader", () => {
  it.each(["", "한글 é 😀", "\uFEFF한글", "\uFEFF\uFEFF한글", "한\uFEFF글"])(
    "preserves UTF-8 and BOM decoding across single-byte chunks: %s",
    async (value) => {
      const bytes = new TextEncoder().encode(value);
      let offset = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (offset === bytes.length) controller.close();
              else controller.enqueue(bytes.slice(offset, ++offset));
            },
          },
          { highWaterMark: 0 },
        ),
      );
      const expected = (await new Response(bytes).text()).replace(/^\uFEFF/, "");
      await expect(
        readBoundedResponseText(response, Math.max(1, bytes.length), () => new Error("limit")),
      ).resolves.toBe(expected);
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each([undefined, "1"])(
    "stops an oversized response before buffering the rest, with content-length %s",
    async (contentLength) => {
      let chunksRead = 0;
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              chunksRead += 1;
              controller.enqueue(new TextEncoder().encode("abcd"));
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        contentLength === undefined ? undefined : { headers: { "content-length": contentLength } },
      );
      const failure = new Error("limit");
      await expect(readBoundedResponseText(response, 8, () => failure)).rejects.toBe(failure);
      expect(chunksRead).toBe(3);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    },
  );

  it("cancels a declared oversized response without reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-length": "9" } },
    );
    await expect(readBoundedResponseText(response, 8, () => new Error("limit"))).rejects.toThrow(
      "limit",
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("keeps the original overflow error when cancelling the body also fails", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(9));
          },
          cancel() {
            throw new Error("cancel failed");
          },
        },
        { highWaterMark: 0 },
      ),
    );
    const failure = new Error("limit");
    await expect(readBoundedResponseText(response, 8, () => failure)).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it("releases a failed reader while preserving the body error", async () => {
    const failure = new Error("connection failed");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(failure);
        },
      }),
    );
    await expect(readBoundedResponseText(response, 8, () => new Error("limit"))).rejects.toBe(
      failure,
    );
    expect(response.body?.locked).toBe(false);
    await expect(
      readBoundedResponseText(new Response(null), 8, () => new Error("limit")),
    ).resolves.toBe("");
  });
});
