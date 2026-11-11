let inFlight: Promise<string | undefined> | undefined;

/** A small static preview; never store a full-resolution viewport capture per scene. */
export async function sceneThumbnail(capture: (() => Promise<string>) | undefined): Promise<string | undefined> {
  if (!capture) return undefined;
  const pending = inFlight ?? captureThumbnail(capture);
  if (!inFlight) {
    inFlight = pending;
    void pending.finally(() => { if (inFlight === pending) inFlight = undefined; });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function captureThumbnail(capture: () => Promise<string>): Promise<string | undefined> {
  try {
    const image = new Image();
    image.src = await capture();
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
    context.drawImage(image, (canvas.width - image.width * scale) / 2, (canvas.height - image.height * scale) / 2, image.width * scale, image.height * scale);
    return canvas.toDataURL('image/jpeg', .7);
  } catch { return undefined; } // A graphics failure must never prevent saving the scene itself.
}
