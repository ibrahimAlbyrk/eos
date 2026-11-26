// The gallery's clock: today at 14:20, moving on from there. Its samples are
// drawn around "now", so a shot taken before dawn would show a day with
// everything crowded at its start, "Good evening" at four and every next run
// "in 15 min". With one fixed hour every shot shows the same day in progress.
// Imported first by EosGallery.jsx, so the samples' times are read from it.
export const GALLERY_HOUR = 14;
export const GALLERY_MINUTE = 20;

const RealDate = globalThis.Date;

function offsetFor(realNow) {
  const at = new RealDate(realNow);
  at.setHours(GALLERY_HOUR, GALLERY_MINUTE, 0, 0);
  return at.getTime() - realNow;
}

export function holdGalleryClock() {
  if (globalThis.Date !== RealDate) return;
  const offset = offsetFor(RealDate.now());
  class GalleryDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = GalleryDate;
}

holdGalleryClock();
