import { desktopCapturer, screen } from 'electron'

/**
 * Grab the primary display as a base64 JPEG.
 *
 * Downscaled to 1280px wide on purpose: that is roughly 1.1k input tokens and
 * still legible for code, slides and spreadsheets. Full resolution costs several
 * times more per frame and buys nothing the model can use.
 */
export async function screenshot(): Promise<string | undefined> {
  const { width, height } = screen.getPrimaryDisplay().size
  const scale = Math.min(1, 1280 / width)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  })

  const image = sources[0]?.thumbnail
  if (!image || image.isEmpty()) return undefined
  return image.toJPEG(70).toString('base64')
}
