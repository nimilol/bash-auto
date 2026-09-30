// Turns a queue item + settings + uploaded images into what the driver should send.
import { matchIngredientsByFilename, withAspectRatio } from '../lib/utils.js';

export const MODES = Object.freeze({
  TEXT: 'text',
  TEXT_TO_IMAGE: 'textToImage',
  IMAGE_TO_IMAGE: 'imageToImage',
  INGREDIENTS: 'ingredients',
});

export function expectsImages(mode) {
  return mode === MODES.TEXT_TO_IMAGE || mode === MODES.IMAGE_TO_IMAGE;
}

/**
 * @param item      queue item { prompt, index }
 * @param settings  side panel settings
 * @param assets    { sourceImages:[{name,dataUrl}], ingredients:[{name,dataUrl}] }
 * @param ctx       { previousImage: {name,dataUrl}|null } — last generated image (chain mode)
 * @returns { prompt, files, expectImages }
 */
export function buildRequest(item, settings, assets, ctx = {}) {
  const mode = settings.mode;
  const files = [];
  let prompt = item.prompt;

  switch (mode) {
    case MODES.TEXT_TO_IMAGE:
      prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    case MODES.IMAGE_TO_IMAGE: {
      const useChain = settings.chain && ctx.previousImage;
      if (useChain) files.push(ctx.previousImage);
      else {
        const src = assets.sourceImages || [];
        if (!src.length) throw new Error('Add at least one source image for Image to Image mode');
        // One source per prompt when counts match, otherwise send the whole set.
        if (src.length > 1 && src.length >= (settings.queueLength || 0)) files.push(src[item.index % src.length]);
        else files.push(...src);
      }
      if (settings.aspectRatio) prompt = withAspectRatio(prompt, settings.aspectRatio);
      break;
    }
    case MODES.INGREDIENTS: {
      const all = assets.ingredients || [];
      const matched = settings.autoMatchIngredients ? matchIngredientsByFilename(prompt, all) : all;
      files.push(...matched);
      break;
    }
    default:
      break;
  }

  return { prompt, files, expectImages: expectsImages(mode) };
}

/**
 * Whether this item should run in a fresh conversation.
 * singleChat: every prompt of the run goes into one session chat; only start one when none exists.
 * Concat keeps one conversation for the whole run so each prompt builds on the last.
 */
export function wantsNewChat(settings, isFirstInRun, hasSessionChat = false) {
  if (settings.singleChat) return !hasSessionChat && isFirstInRun;
  if (settings.mode === MODES.TEXT && settings.concat) return isFirstInRun;
  return settings.newChatPerPrompt || (isFirstInRun && settings.newChatOnStart);
}
