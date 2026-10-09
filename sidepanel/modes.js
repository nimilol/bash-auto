// Turns a queue item + settings + uploaded images into what the content script should send.
import { matchIngredientsByFilename, withAspectRatio } from '../lib/utils.js';

export const MODES = Object.freeze({
  TEXT: 'text',
  INGREDIENTS: 'ingredients',
  TEXT_TO_IMAGE: 'textToImage',
  IMAGE_TO_IMAGE: 'imageToImage',
});

export const MODE_LIST = [MODES.TEXT, MODES.INGREDIENTS, MODES.TEXT_TO_IMAGE, MODES.IMAGE_TO_IMAGE];

export const expectsImages = (mode) => mode === MODES.TEXT_TO_IMAGE || mode === MODES.IMAGE_TO_IMAGE;

/** Which uploaded image list a mode uses. */
export const assetKind = (mode) => (mode === MODES.INGREDIENTS ? 'ingredients' : mode === MODES.IMAGE_TO_IMAGE ? 'sourceImages' : null);

const clamp = (n, lo, hi, fallback) => Math.min(hi, Math.max(lo, Math.round(Number(n)) || fallback));

/**
 * @param item      queue item { prompt, mode, index, imageMode }
 * @param settings  panel settings
 * @param assets    { sourceImages:[{name,dataUrl}], ingredients:[{name,dataUrl}] }
 * @param ctx       { previousImage: {name,dataUrl}|null, promptCount } — last generated image ("Last Image")
 * @returns { prompt, files, expectImages }
 */
export function buildRequest(item, settings, assets, ctx = {}) {
  const mode = item.mode || settings.mode;
  let prompt = item.prompt;
  let files = [];
  const chained = item.imageMode === 'last' && ctx.previousImage;

  switch (mode) {
    case MODES.INGREDIENTS: {
      const all = assets.ingredients || [];
      files = settings.autoAddCharacters ? matchIngredientsByFilename(prompt, all) : all;
      files = files.slice(0, clamp(settings.maxIngredientImages, 1, 3, 3));
      break;
    }
    case MODES.TEXT_TO_IMAGE:
      if (chained) files = [ctx.previousImage];
      prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    case MODES.IMAGE_TO_IMAGE: {
      const max = clamp(settings.maxImageInputs, 1, 10, 4);
      if (chained) {
        files = [ctx.previousImage];
      } else {
        const src = assets.sourceImages || [];
        const matched = settings.autoAddCharacters ? matchIngredientsByFilename(prompt, src) : [];
        if (matched.length) files = matched;
        // As many images as prompts: one each, in order. Otherwise every image goes with every prompt.
        else if (src.length > 1 && src.length >= (ctx.promptCount || 0)) files = [src[item.index % src.length]];
        else files = src;
        if (!files.length) throw new Error('Add at least one source image for Image to Image mode');
      }
      files = files.slice(0, max);
      prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    }
    default:
      break;
  }
  return { prompt, files, expectImages: expectsImages(mode) };
}

/**
 * Does this item run in a new chat? Only when the item run just before it by the same worker asked
 * to "Concat" (continue in the same chat) and completed does it stay in that chat.
 */
export function startsNewChat(previous) {
  return !(previous && previous.chatMode === 'concat' && previous.status === 'completed');
}

/** Queue items for a list of prompts: one per output wanted. */
export function makeItems(prompts, { mode, firstIndex, outputs, chatMode, imageMode }, newId = () => crypto.randomUUID()) {
  const copies = clamp(outputs, 1, 50, 1);
  const items = [];
  prompts.forEach((prompt, n) => {
    for (let copy = 0; copy < copies; copy++) {
      items.push({
        id: newId(),
        index: firstIndex + n,
        copy,
        copies,
        prompt,
        mode,
        chatMode: expectsImages(mode) ? 'new' : chatMode,
        imageMode: expectsImages(mode) ? imageMode : 'new',
        status: 'queued',
        retries: 0,
        error: '',
      });
    }
  });
  return items;
}
