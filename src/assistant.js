// The AI editor. With an Anthropic API key, Claude plans the edit and drives the editor through tools.
// Without one, a small offline command reader handles the common requests.

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { Actions, catalogText } from './actions.js';

export const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'clipwave:anthropic-key';

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* storage blocked */
  }
}

const SYSTEM = `You are the editing assistant inside Clipwave, a video editor. The person describes the edit they want in plain words and you make it with the tools. You can see the project only through get_project.

How the editor works:
- Times are in seconds on the timeline. Clips sit on tracks; the main track is magnetic (its clips always play back to back from 0, so start times there are decided by order). Overlay video tracks, text tracks (text, stickers, shapes), effect tracks and audio tracks hold freely placed clips.
- Positions: x and y are fractions of the frame from its center (-0.5 left/top edge, 0.5 right/bottom edge). scale 1 means the clip fits the frame; use fill_frame to cover it.
- Effects and filters can go on one clip (clip_id) or on an effect track over a time range, which changes everything below that track.
- Text sizes are pixels at 1080p height. Good caption size is 60 to 90; titles 110 to 200.

How to work:
- Call get_project first, and again after big changes, so ids and times are current.
- Make the edit the person asked for, in sensible steps. Use real ids from the catalogs below; never invent ids.
- Prefer the smart tools when they fit: remove_silences for talking videos, cut_to_beat once music is on the timeline, highlight_reel for long footage, auto_captions for speech, auto_reframe to change shape.
- If something can't be done with these tools, say so briefly instead of guessing.
- Downloads (music, photos) and the AI tools can take a while; that's fine.
- Finish with one or two short sentences saying what you changed, in plain everyday words. Everything is undoable with Ctrl+Z, so don't ask for permission for ordinary edits.

${catalogText()}`;

// JSON Schema helpers
const num = (description) => ({ type: 'number', description });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

export function buildTools(actions, log) {
  const tool = (name, description, schema, fn, label) =>
    betaTool({
      name,
      description,
      inputSchema: schema,
      run: async (input) => {
        const line = log(label ? label(input || {}) : name.replace(/_/g, ' '), 'run');
        try {
          const out = await fn(input || {}, (p, msg) => line.progress(p, msg));
          line.done();
          return typeof out === 'string' ? out : JSON.stringify(out);
        } catch (e) {
          line.fail(e.message);
          return 'Error: ' + e.message;
        }
      },
    });
  const a = actions;
  return [
    tool('get_project', 'Read the whole project: canvas, tracks with their clips (ids, times, text, effects), markers, playhead, selection and the media library.', obj({}), () => a.summary(), () => 'Reading the timeline'),
    tool('add_media', 'Put a file from the media library on the timeline. Video and photos go to the main track (inserted at the nearest cut) or an overlay track; audio goes to an audio track.', obj({ media_id: str('Media library id'), track: str('main, overlay or audio', { enum: ['main', 'overlay', 'audio'] }), start: num('Timeline time in seconds (ignored on the main track, which is magnetic)') }, ['media_id']), (i) => a.addMedia(i), (i) => 'Adding a clip'),
    tool('update_clip', 'Change a clip: timing (start, duration, source_in, speed), sound (volume 0-2, muted, fade_in, fade_out) or picture (x, y, scale, rotation in degrees, opacity 0-1, blend mode, flip_horizontal).', obj({
      clip_id: str('Clip id'), start: num('New start time'), duration: num('New length in seconds'), source_in: num('Where in the source file the clip starts'), speed: num('0.1 to 10'),
      volume: num('0 to 2'), muted: { type: 'boolean' }, fade_in: num('seconds'), fade_out: num('seconds'),
      x: num('-0.5..0.5'), y: num('-0.5..0.5'), scale: num('1 = fit'), rotation: num('degrees'), opacity: num('0..1'),
      blend: str('normal, multiply, screen, overlay, darken, lighten, dodge, burn, hardlight, softlight, difference, exclusion, add, color, luminosity'), flip_horizontal: { type: 'boolean' },
    }, ['clip_id']), (i) => a.updateClip(i), () => 'Adjusting a clip'),
    tool('fill_frame', 'Scale a video or photo clip so it covers the whole frame (no bars).', obj({ clip_id: str('Clip id') }, ['clip_id']), (i) => a.fillFrame(i), () => 'Filling the frame'),
    tool('split_clip', 'Cut a clip in two at a timeline time. Without clip_id, cuts the main-track clip under that time.', obj({ time: num('Seconds'), clip_id: str('Clip id (optional)') }, ['time']), (i) => a.split(i), (i) => `Splitting at ${i.time}s`),
    tool('delete_clips', 'Remove clips. ripple closes the gap on non-main tracks (the main track always closes gaps).', obj({ clip_ids: { type: 'array', items: { type: 'string' } }, ripple: { type: 'boolean' } }, ['clip_ids']), (i) => a.deleteClips(i), (i) => `Deleting ${i.clip_ids ? i.clip_ids.length : ''} clip(s)`),
    tool('add_text', 'Add a text clip. style picks one of the TEXT STYLES (fonts, colors and animation included).', obj({ text: str('What it says'), start: num('Seconds'), duration: num('Seconds'), style: str('Text style name'), x: num('-0.5..0.5'), y: num('-0.5..0.5 (0.35 is a good caption line)'), size: num('px at 1080p'), color: str('#rrggbb'), font: str('Font name') }, ['text']), (i) => a.addText(i), (i) => `Adding text “${String(i.text || '').slice(0, 30)}”`),
    tool('edit_text', 'Change a text clip.', obj({ clip_id: str('Clip id'), text: str('New words'), size: num('px'), color: str('#rrggbb'), font: str('Font'), bold: { type: 'boolean' }, outline_width: num('px'), outline_color: str('#rrggbb'), background: { type: 'boolean' } }, ['clip_id']), (i) => a.editText(i), () => 'Editing text'),
    tool('add_sticker', 'Add an emoji sticker.', obj({ emoji: str('One emoji'), start: num('Seconds'), duration: num('Seconds'), x: num(''), y: num(''), scale: num('') }, ['emoji']), (i) => a.addSticker(i), (i) => `Adding ${i.emoji || 'a sticker'}`),
    tool('add_effect', 'Add a video effect from EFFECTS to one clip (clip_id), or as an effect-track clip over start..start+duration that changes everything below.', obj({ effect_id: str('Effect id'), clip_id: str('Clip id (optional)'), start: num('Seconds'), duration: num('Seconds'), params: { type: 'object', description: 'Optional effect settings by name', additionalProperties: true } }, ['effect_id']), (i) => a.addEffect(i), (i) => `Adding ${i.effect_id} effect`),
    tool('set_filter', 'Apply a color filter from FILTERS to a clip, to "all" video and photo clips, or as a filter layer over a time range. filter_id null removes it from clips.', obj({ filter_id: { type: ['string', 'null'] }, clip_id: str('Clip id, or "all"'), intensity: num('0..1'), start: num('Seconds'), duration: num('Seconds') }, ['filter_id']), (i) => a.setFilter(i), (i) => `Color: ${i.filter_id || 'none'}`),
    tool('set_transition', 'Set the transition into a clip from the clip before it (they must touch), or clip_id "all" for every cut on the main track. transition_id null removes it.', obj({ clip_id: str('Clip id or "all"'), transition_id: { type: ['string', 'null'] }, duration: num('0.1 to 3 seconds') }, ['clip_id', 'transition_id']), (i) => a.setTransition(i), (i) => `Transition: ${i.transition_id || 'none'}`),
    tool('set_animation', 'Animate a clip. slot in/out/loop with a CLIP ANIMATION id; for text clips you may also use a TEXT LETTER ANIMATION id. animation_id null removes it.', obj({ clip_id: str('Clip id'), slot: str('in, out or loop', { enum: ['in', 'out', 'loop'] }), animation_id: { type: ['string', 'null'] }, duration: num('Seconds') }, ['clip_id', 'slot', 'animation_id']), (i) => a.setAnimation(i), (i) => `Animation: ${i.animation_id || 'none'}`),
    tool('set_canvas', 'Change the frame shape and background fill (color, blur of the main clip, or gradient).', obj({ aspect: str('One of the CANVAS SHAPES'), background: str('color, blur or gradient', { enum: ['color', 'blur', 'gradient'] }), color: str('#rrggbb') }), (i) => a.setCanvas(i), () => 'Changing the canvas'),
    tool('add_marker', 'Drop a marker on the timeline.', obj({ time: num('Seconds'), label: str('Name') }, ['time']), (i) => a.addMarker(i), () => 'Adding a marker'),
    tool('search_music', 'Search free Creative Commons songs (kind music) or sound effects (kind sounds). Returns result_ids for add_search_result.', obj({ query: str('Mood, genre or sound'), kind: str('music or sounds', { enum: ['music', 'sounds'] }) }, ['query']), (i) => a.searchMusic(i), (i) => `Searching songs: ${i.query}`),
    tool('search_photos', 'Search free Creative Commons photos. Returns result_ids for add_search_result.', obj({ query: str('What the photo shows'), shape: str('wide, tall or square', { enum: ['wide', 'tall', 'square'] }) }, ['query']), (i) => a.searchPhotos(i), (i) => `Searching photos: ${i.query}`),
    tool('add_search_result', 'Download a search result and put it on the timeline (music on an audio track, trimmed to the edit; photos on the main track or an overlay). Returns the credit line to mention to the person.', obj({ result_id: str('From search_music or search_photos'), start: num('Seconds'), track: str('main or overlay (photos)', { enum: ['main', 'overlay'] }), volume: num('0..2 for music') }, ['result_id']), (i) => a.addResult(i), () => 'Downloading'),
    tool('auto_captions', 'Transcribe the speech on the timeline and add caption clips (runs Whisper on this computer).', obj({ language: str('english, spanish… or empty to detect'), style: str('Subtitle, Karaoke, Word Pop or Meme Caption', { enum: ['Subtitle', 'Karaoke', 'Word Pop', 'Meme Caption'] }) }), (i, pr) => a.captions(i, pr), () => 'Writing captions'),
    tool('remove_silences', 'Cut out the quiet pauses in a talking clip (or every clip with sound) and close the gaps.', obj({ clip_id: str('Clip id (optional)'), threshold_db: num('-45 (cut less) to -20 (cut more), default -32') }), (i) => a.silences(i), () => 'Cutting silences'),
    tool('cut_to_beat', 'Rebuild the main track as quick cuts on the beats of the song on the audio track, using the clips already on the main track (or the library).', obj({ beats_per_cut: num('1, 2 or 4'), transition_id: str('Optional transition id for each cut') }), (i) => a.beat(i), () => 'Cutting to the beat'),
    tool('highlight_reel', 'Rebuild the main track from the liveliest moments of the videos (loud and moving parts).', obj({ length_seconds: num('Target length'), piece_seconds: num('Length of each moment') }), (i, pr) => a.highlights(i, pr), () => 'Finding the best moments'),
    tool('auto_reframe', 'Change the frame shape and keep faces in view in every clip.', obj({ aspect: str('One of the CANVAS SHAPES') }, ['aspect']), (i, pr) => a.reframe(i, pr), (i) => `Reframing to ${i.aspect}`),
    tool('stabilize', 'Smooth out camera shake in a video clip.', obj({ clip_id: str('Clip id'), smoothness: num('0..1') }, ['clip_id']), (i, pr) => a.stabilize(i, pr), () => 'Stabilizing'),
    tool('background', 'Remove the background around people (remove), blur it (blur), or turn that off (off).', obj({ clip_id: str('Clip id'), mode: str('remove, blur or off', { enum: ['remove', 'blur', 'off'] }) }, ['clip_id']), (i) => a.background(i), (i) => `Background: ${i.mode || 'remove'}`),
    tool('reverse_clip', 'Make a video clip play backwards (or forwards again).', obj({ clip_id: str('Clip id') }, ['clip_id']), (i, pr) => a.reverse(i, pr), () => 'Reversing'),
    tool('voiceover', 'Make a spoken voice clip from text (English) and put it on an audio track.', obj({ text: str('What to say'), voice: str('Voice id from VOICES'), start: num('Seconds') }, ['text']), (i, pr) => a.voice(i, pr), () => 'Recording a voiceover'),
  ];
}

// Runs one request. log(label) returns a handle with progress/done/fail for the chat view.
export async function runClaude(app, history, userText, { log, onText, signal }) {
  const key = getKey();
  if (!key) throw new Error('Add your Anthropic API key first.');
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const actions = (app.aiActions = app.aiActions || new Actions(app));
  const sel = app.store.selection.length ? ` Selected clip ids: ${app.store.selection.join(', ')}.` : '';
  const messages = [...history, { role: 'user', content: `${userText}\n\n(Playhead at ${app.player.time.toFixed(2)}s.${sel})` }];
  const runner = client.beta.messages.toolRunner(
    {
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: buildTools(actions, log),
      messages,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      max_iterations: 40,
    },
    { signal },
  );
  let refused = false;
  for await (const message of runner) {
    for (const block of message.content) if (block.type === 'text' && block.text.trim()) onText(block.text);
    if (message.stop_reason === 'refusal') refused = true;
  }
  if (refused) onText('I can’t help with that one.');
  return runner.params.messages;
}

export function apiErrorMessage(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'That API key was not accepted. Check it in AI settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use that model. Check your Anthropic account.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is busy or your account hit its limit. Wait a moment and try again.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Claude. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Claude returned an error (${e.status}): ${e.message}`;
  if (e && e.name === 'AbortError') return 'Stopped.';
  return (e && e.message) || 'Something went wrong.';
}

// ---------- offline commands ----------

const ASPECT_WORDS = [[/9\s*[:x/]\s*16|vertical|tiktok|reels?|shorts|portrait/, '9:16'], [/16\s*[:x/]\s*9|landscape|youtube|wide/, '16:9'], [/1\s*[:x/]\s*1|square/, '1:1'], [/4\s*[:x/]\s*5|instagram/, '4:5']];

// Returns {reply} when it understood the request, or null.
export async function runLocal(app, text, { log }) {
  const a = (app.aiActions = app.aiActions || new Actions(app));
  const t = text.toLowerCase().trim();
  const sel = app.store.primary();
  const step = async (label, fn) => {
    const line = log(label, 'run');
    try {
      const out = await fn((p, msg) => line.progress(p, msg));
      line.done();
      return out;
    } catch (e) {
      line.fail(e.message);
      throw e;
    }
  };
  let m;
  if (/silen|pauses?|jump ?cut|dead air|umm?s?\b/.test(t)) return { reply: await step('Cutting silences', () => a.silences({ clip_id: sel && (sel.clip.type === 'video' || sel.clip.type === 'audio') ? sel.clip.id : undefined })) };
  if (/beat|rhythm|music sync|sync to (the )?(music|song)/.test(t)) return { reply: await step('Cutting to the beat', () => a.beat({ beats_per_cut: /fast|every beat/.test(t) ? 1 : /slow/.test(t) ? 4 : 2 })) };
  if (/highlight|best (parts|moments|bits)|recap|montage/.test(t)) return { reply: await step('Finding the best moments', (pr) => a.highlights({ length_seconds: +(t.match(/(\d+)\s*(s|sec|second)/) || [0, 30])[1] }, pr)) };
  if (/caption|subtitle|transcri/.test(t)) return { reply: await step('Writing captions', (pr) => a.captions({ style: /karaoke/.test(t) ? 'Karaoke' : /word/.test(t) ? 'Word Pop' : 'Subtitle' }, pr)) };
  for (const [re, aspect] of ASPECT_WORDS) if ((/make|turn|convert|reframe|change|switch/.test(t) || /^(vertical|square)/.test(t)) && re.test(t)) return { reply: await step(`Reframing to ${aspect}`, (pr) => a.reframe({ aspect }, pr)) };
  if (/stabili|shak/.test(t)) {
    if (!sel || sel.clip.type !== 'video') return { reply: 'Select the shaky video clip first, then ask again.' };
    return { reply: await step('Stabilizing', (pr) => a.stabilize({ clip_id: sel.clip.id }, pr)) };
  }
  if (/background|green ?screen|cut ?out/.test(t)) {
    if (!sel || (sel.clip.type !== 'video' && sel.clip.type !== 'image')) return { reply: 'Select the clip with the person in it first.' };
    return { reply: await step('Removing the background', () => a.background({ clip_id: sel.clip.id, mode: /blur/.test(t) ? 'blur' : 'remove' })).then(() => 'Background ' + (/blur/.test(t) ? 'blurred.' : 'removed.')) };
  }
  if (/revers|backwards/.test(t)) {
    if (!sel || sel.clip.type !== 'video') return { reply: 'Select a video clip first.' };
    return { reply: await step('Reversing', (pr) => a.reverse({ clip_id: sel.clip.id }, pr)) };
  }
  if ((m = t.match(/(?:add|find|put|play)\s+(?:some\s+|a\s+)?(?:(.+?)\s+)?(?:music|song|track|beat)(?:\s+(?:like|that is|that's)\s+(.+))?$/))) {
    const q = (m[2] || m[1] || 'upbeat').replace(/\b(some|a|an|the|nice|good|background)\b/g, '').trim() || 'upbeat';
    const found = await step(`Searching songs: ${q}`, () => a.searchMusic({ query: q }));
    if (!found.length) return { reply: `No free songs found for “${q}”. Try other words.` };
    const pick = found.find((r) => r.seconds >= 30) || found[0];
    const res = await step(`Adding “${pick.title}”`, () => a.addResult({ result_id: pick.result_id, start: 0, volume: 0.6 }));
    return { reply: `Added “${pick.title}” by ${pick.creator} (${pick.license}). Credit: ${res.credit}` };
  }
  if ((m = t.match(/(?:add|find|put)\s+(?:a\s+|some\s+)?(?:photo|picture|image|pic)s?\s+(?:of\s+)?(.+)$/))) {
    const found = await step(`Searching photos: ${m[1]}`, () => a.searchPhotos({ query: m[1], shape: app.store.project.width < app.store.project.height ? 'tall' : 'wide' }));
    if (!found.length) return { reply: `No free photos found for “${m[1]}”.` };
    await step(`Adding “${found[0].title}”`, () => a.addResult({ result_id: found[0].result_id }));
    return { reply: `Added a photo by ${found[0].creator} (${found[0].license}).` };
  }
  if ((m = text.match(/(?:add|put|write)\s+(?:a\s+)?(?:title|text|caption)\s*(?:that says|saying|:)?\s*["“']?(.+?)["”']?\s*$/i))) {
    const res = await step('Adding text', () => a.addText({ text: m[1], start: app.player.time, style: /title/i.test(text) ? 'Bold Title' : undefined }));
    return { reply: `Added the text at ${app.player.time.toFixed(1)}s.`, ...res };
  }
  if (/transition/.test(t)) {
    const id = /zoom/.test(t) ? 'CrossZoom' : /glitch/.test(t) ? 'GlitchMemories' : /black|dip/.test(t) ? 'fadecolor' : /cube|3d/.test(t) ? 'cube' : /wipe/.test(t) ? 'wipeLeft' : 'fade';
    return { reply: await step(`Adding ${id} transitions`, () => a.setTransition({ clip_id: 'all', transition_id: id, duration: 0.5 })) };
  }
  const look = [[/cinematic|movie|film look/, 'teal-orange'], [/vintage|retro|old/, 'kodak70'], [/black and white|b&w|noir|grayscale/, 'bw-high'], [/warm|golden/, 'golden'], [/cold|cool|blue/, 'cold'], [/vivid|colorful|pop/, 'vivid'], [/moody|dark/, 'moody']].find(([re]) => re.test(t));
  if (look && /look|color|grade|filter|make it|style/.test(t)) return { reply: await step('Color grading', () => a.setFilter({ filter_id: look[1], clip_id: 'all' })) + '.' };
  if (/undo/.test(t)) {
    app.undo();
    return { reply: 'Undone.' };
  }
  return null;
}

export const LOCAL_HELP = 'Without an API key I understand things like: “remove the silences”, “cut to the beat”, “make a 30 second highlight reel”, “add captions”, “make it vertical”, “add lofi music”, “add a photo of the beach”, “add a title that says Summer Trip”, “add zoom transitions”, “cinematic look”, “stabilize”, “remove the background”, “reverse”. Add a Claude API key in AI settings and I can do any edit you describe.';
