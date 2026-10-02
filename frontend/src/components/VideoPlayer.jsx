// components/VideoPlayer.jsx


import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../utils/format.js';

// Load the YouTube script only once
// apiPromise is a module-level cache: every component that asks for the API gets the
// same promise, so the <script> tag is added to the page exactly one time.
let apiPromise = null;
function loadYouTubeApi() {
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      // the API may already be on the page (for example after a hot reload)
      if (window.YT && window.YT.Player) return resolve(window.YT);
      // YouTube calls this global function once the script has finished loading
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => {
        apiPromise = null; // allow a later try
        reject(new Error('YouTube script blocked'));
      };
      document.head.appendChild(tag);
      // Safety net: an ad blocker or proxy can let the script "load" without ever
      // calling onYouTubeIframeAPIReady. onerror does not cover that case, and without
      // this the promise would never settle - the player would stay blank forever with
      // no message. Rejecting after 10s turns it into a visible error instead.
      // (Rejecting an already-settled promise is harmless, so this is safe on success.)
      setTimeout(() => {
        if (!(window.YT && window.YT.Player)) {
          apiPromise = null; // allow a later try
          reject(new Error('YouTube player did not start'));
        }
      }, 10000);
    });
  }
  return apiPromise;
}

// Drift limits. Being behind the room looks bad, so we catch up quickly (1.5s).
// Being slightly ahead is usually just buffering, so we tolerate more (4s) before jumping back.
const MAX_DRIFT_SECONDS = 1.5; // how far behind the room before we catch up
const MAX_AHEAD_SECONDS = 4; // how far ahead of the room before we go back
const SEEK_JUMP_SECONDS = 1.5; // a jump bigger than this (that we did not cause) means the user seeked

// YouTube player states
const UNSTARTED = -1;
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const CUED = 5;

// Prints every jump we make to the browser console (F12), so a strange rewind can be traced.
function debugSeek(player, target, reason) {
  console.info(
    `[watch-party] jump: ${reason}. from ${Number(player.getCurrentTime()).toFixed(1)}s to ${Number(target).toFixed(1)}s`
  );
}

// A subtitle choice written as one comparable string: '' means "subtitles off",
// otherwise "lang|kind" such as "en|asr". Comparing strings keeps the checks below short.
function captionsKey(captions) {
  return captions && captions.lang ? `${captions.lang}|${captions.kind || ''}` : '';
}

// What THIS player is really showing right now, in the same written form.
// Reading subtitles uses YouTube's UNDOCUMENTED caption API, so every read is wrapped:
// a captions module that is missing or not ready yet must never break the player.
function readCaptions(player) {
  try {
    const track = player.getOption && player.getOption('captions', 'track');
    return track && track.languageCode ? { lang: track.languageCode, kind: track.kind || '' } : null;
  } catch (err) {
    return null;
  }
}

// Does this video even offer the track the room asked for? When it does not, there is
// nothing to obey - and, just as important, nothing to report either: a player that
// cannot show the subtitles must not keep telling the room to switch them off, which
// is how the host and a moderator used to undo each other's choice over and over.
function hasCaptionTrack(player, captions) {
  if (!captions || !captions.lang) return true; // "subtitles off" is always possible
  try {
    const list = (player.getOption && player.getOption('captions', 'tracklist')) || [];
    return list.some((t) => t.languageCode === captions.lang);
  } catch (err) {
    return true; // unknown: assume it can be shown rather than fight the room over it
  }
}

// This is YouTube's own player with all its own controls.
// We watch what the user does in it:
//   host / moderator -> the change is sent to the server and everyone follows
//   participant      -> their player goes back to the room's state and a request is sent
export default function VideoPlayer({ syncState, role, onAction }) {
  // ref to the <div> the iframe is injected into, and to the YT.Player instance itself
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  // Every ref below is a "memory" that survives between renders without causing a re-render.
  const loadedVideoIdRef = useRef(null); // the video the player currently has
  const settleUntilRef = useRef(0); // after an automatic correction, wait before correcting again
  // THE anti-loop guard: while we are the ones changing the player, YouTube fires its own
  // events (play/pause/seek). ignoreUntilRef makes us drop those events, so we never echo
  // our own change back to the server as if the user had done it.
  const ignoreUntilRef = useRef(0); // while we control the player ourselves, ignore its events
  const lastTimeRef = useRef({ time: 0, at: Date.now() }); // used to notice when the user seeks
  const wantPlayingRef = useRef(false); // what the room says: should the video be playing?
  const confirmedRef = useRef(false); // true once the loaded video is really showing in the player
  const retriesRef = useRef(0); // how many times we re-tried a video that would not load
  const autoMutedRef = useRef(false); // the browser forced our sound off (autoplay rules)
  // The next three are debounces: they remember when we last SENT a change, so one
  // user action (which YouTube may report several times) is not sent to the server twice.
  const muteSentAtRef = useRef(0); // stops a host's mute change from being sent twice
  const rateSentAtRef = useRef(0); // same for the speed
  // Same idea for play and pause. The scan below keeps re-asserting the room's play/pause
  // so a player that never started cannot stay stuck, and this is what stops it from
  // undoing a press the user just made: YouTube's own event takes 400ms to be confirmed,
  // and the room would still be showing the old state for that whole time.
  const playSentAtRef = useRef(0);
  const playFixAtRef = useRef(0); // when we last had to ask the player to play or pause again
  // The room's mute setting and speed this player has already obeyed. Mute and speed do not
  // drift the way a video position does: they only need pushing into the player when the
  // room's value CHANGES. Re-applying an unchanged value on every sync is what used to erase
  // a host's or moderator's own change before the 500ms scan below could report it - the scan
  // finds a change only after up to half a second, and any sync arriving in that window put
  // the old value straight back, so the change was never sent and nobody else followed.
  // null means "not obeyed anything yet", so the first sync always applies.
  const appliedMutedRef = useRef(null);
  const appliedRateRef = useRef(null);
  const loadedAtRef = useRef(0); // when the current video started loading
  const captionPendingRef = useRef(null); // a subtitle change somebody made here, waiting to be sure it is real
  // The room's subtitle choice this player has already obeyed, written with captionsKey().
  // null means "not obeyed anything yet", so the first sync always applies.
  const appliedCaptionsRef = useRef(null);
  const captionApplyAtRef = useRef(0); // when we last pushed a subtitle choice into the player

  // always-fresh copies for the YouTube callbacks, which are created only once
  // The event handlers below are built a single time when the player is created, so they
  // would otherwise close over the props from that one render forever. These refs are
  // re-assigned on every render, so the callbacks always read the latest values.
  const syncRef = useRef(syncState);
  const roleRef = useRef(role);
  const onActionRef = useRef(onAction);
  syncRef.current = syncState;
  roleRef.current = role;
  onActionRef.current = onAction;

  const [ready, setReady] = useState(false); // true once the YouTube player exists
  const [progress, setProgress] = useState({ current: 0, duration: 0 }); // shown to participants
  const [problem, setProblem] = useState(''); // shown instead of a silent blank player
  const [autoMuted, setAutoMuted] = useState(false); // the browser forced the sound off

  // fullscreen state + ref to the wrapper element we put into fullscreen
  const [isFullscreen, setIsFullscreen] = useState(false);
  const wrapperRef = useRef(null);

  // controllers may change the room; participants may only watch and send requests
  const isController = role === 'host' || role === 'moderator';

  const hasVideo = Boolean(syncState && syncState.videoId);

  // from now on, ignore the player's own events for a moment (we are the one changing it)
  // Math.max means a longer existing window is never shortened by a shorter new one.
  function ignoreEvents(ms = 1500) {
    ignoreUntilRef.current = Math.max(ignoreUntilRef.current, Date.now() + ms);
  }

  // The room's mute setting is shared: when the host mutes, everyone is muted.
  // (Skipped while the browser forced our sound off, so autoplay does not break.)
  // Playback speed is shared too, so everyone moves through the video at the same pace.
  // force = true means "put the room's value back no matter what" and is used for a fresh
  // video and for undoing something a participant did; a plain sync only applies a CHANGE.
  function applyRate(player, sync, force = false) {
    if (!player.getPlaybackRate) return; // player not fully ready
    const wantRate = sync.rate || 1; // if the server has no rate, normal speed
    if (!force && wantRate === appliedRateRef.current) return; // room did not change: leave the player alone
    appliedRateRef.current = wantRate;
    // only touch the player if it is actually different, so we do not fight YouTube
    if (Math.abs(player.getPlaybackRate() - wantRate) > 0.01) {
      ignoreEvents(); // our own change, do not report it back as a user action
      player.setPlaybackRate(wantRate);
    }
  }

  // Subtitles are part of the room's shared state (like mute and speed), so everyone
  // follows whoever changed them. This is the low-level part: push one choice into
  // the player. It uses YouTube's UNDOCUMENTED caption controls (loadModule /
  // setOption), so it is best-effort: YouTube may change it without notice, and it
  // often needs more than one call (the captions module loads in the background).
  function applyCaptions(player, sync) {
    if (!player.setOption || !player.getOption) return; // API not ready
    const want = sync.captions || null; // { lang, kind } or null for off
    try {
      if (!want) {
        // Subtitles must be OFF. YouTube may have turned them on by itself (for example
        // automatic subtitles), and reading the current state is not reliable,
        // so switch them off every time.
        player.setOption('captions', 'track', {});
        player.unloadModule('captions');
        return;
      }
      const track = player.getOption('captions', 'track');
      const sameLang = track && track.languageCode === want.lang;
      const sameKind = (track && track.kind ? track.kind : '') === (want.kind || '');
      if (sameLang && sameKind) return; // already right, nothing to do

      // Step 1: the captions module must be loaded first. It loads in the background,
      // so stop here and finish on the next check (do not reload it again and again).
      const modules = player.getOptions ? player.getOptions() : [];
      if (!modules.includes('captions')) {
        console.info('[watch-party] loading the subtitle module');
        player.loadModule('captions');
        return;
      }

      // Step 2: pick the exact track from YouTube's own list of tracks
      const list = player.getOption('captions', 'tracklist') || [];
      // prefer an exact lang + kind match; fall back to just the language
      const match =
        list.find((t) => t.languageCode === want.lang && (t.kind || '') === (want.kind || '')) ||
        list.find((t) => t.languageCode === want.lang);
      if (match) {
        console.info('[watch-party] turning on subtitles:', want.lang, want.kind || '');
        player.setOption('captions', 'track', match);
      } else {
        console.info('[watch-party] this video has no subtitle track for', want.lang, '(tracks found:', list.length, ')');
      }
    } catch (err) {
      // the video may not have such subtitles, nothing to do
    }
  }

  // Obey the room's subtitle choice.
  // The choice is remembered, so it is pushed into the player once and not once per
  // update - but only once the player really shows it (or the video has no such track
  // at all), so a captions module that was still loading gets another try later.
  // minGapMs throttles those retries when called from the fast polling loop below.
  function applyRoomCaptions(player, sync, minGapMs = 0) {
    const wantKey = captionsKey(sync.captions);
    if (appliedCaptionsRef.current === wantKey) return; // already obeying the room
    if (minGapMs && Date.now() - captionApplyAtRef.current < minGapMs) return; // do not hammer the API
    captionApplyAtRef.current = Date.now();
    applyCaptions(player, sync);
    if (captionsKey(readCaptions(player)) === wantKey || !hasCaptionTrack(player, sync.captions)) {
      appliedCaptionsRef.current = wantKey;
    }
  }

  // Match the room's mute setting. The host mutes everyone, so this runs for all roles.
  // Like the speed above, this only acts when the room's value CHANGES (or when forced).
  // Because the scan further down finds a local change only after up to 500ms, forcing the
  // room's value on every sync used to undo that change before it was ever sent.
  function applyMute(player, sync, force = false) {
    // do not fight the browser's autoplay muting, and do nothing until the player is ready
    if (autoMutedRef.current || !player.isMuted) return;
    const wantMuted = Boolean(sync.muted);
    if (!force && wantMuted === appliedMutedRef.current) return; // room did not change: leave the player alone
    appliedMutedRef.current = wantMuted;
    if (player.isMuted() !== wantMuted) {
      ignoreEvents(); // our own change, not a user action
      if (wantMuted) player.mute();
      else player.unMute();
    }
  }

  // ---- make the player match the room's state ----
  // force = true is used to undo something a participant did
  function applyState(sync, force = false) {
    const player = playerRef.current;
    if (!player || !sync || !sync.videoId) return; // nothing to do

    const playing = sync.playState === 'playing';
    wantPlayingRef.current = playing;
    // The server time was right when it arrived. Add the time that passed since then.
    // This is why two computers' clocks are never compared: we only use the gap between
    // the moment the update arrived and now, which is measured on THIS machine.
    // (receivedAt defaults to now, so a missing stamp can never produce NaN and freeze the player.)
    const elapsed = playing ? ((Date.now() - (sync.receivedAt || Date.now())) / 1000) * (sync.rate || 1) : 0;
    const target = sync.currentTime + elapsed; // where the video should be right now

    // different video: load it at the right position
    if (loadedVideoIdRef.current !== sync.videoId) {
      ignoreEvents(2500); // loading fires events we must not mistake for user actions
      loadedVideoIdRef.current = sync.videoId;
      confirmedRef.current = false; // until it shows up, do not treat anything as a user action
      loadedAtRef.current = Date.now();
      // A new video has its own subtitles, so whatever we obeyed for the last one
      // says nothing about this one: apply the room's choice again from scratch.
      appliedCaptionsRef.current = null;
      lastTimeRef.current = { time: target, at: Date.now() };
      const options = { videoId: sync.videoId, startSeconds: target };
      // play right away, or just cue it (load and wait paused)
      if (playing) {
        player.loadVideoById(options);
        checkAutoplay();
      } else {
        player.cueVideoById(options);
      }
      // A fresh player may have its own mute and speed, so put the room's values back.
      applyMute(player, sync, true);
      applyRate(player, sync, true);
      // if the video has not shown up after 8 seconds, load it again (up to 2 times)
      setTimeout(() => {
        if (loadedVideoIdRef.current === sync.videoId && !confirmedRef.current && retriesRef.current < 2) {
          retriesRef.current += 1;
          console.info('[watch-party] video did not load, trying again');
          loadedVideoIdRef.current = null; // pretend we loaded nothing, so applyState loads it again
          applyState(syncRef.current, true);
        }
      }, 8000);
      return;
    }

    const state = player.getPlayerState();
    // updatedBy is only present when someone pressed a button. The 15 second re-sync has none.
    // isAction therefore means "a person caused this change", as opposed to a routine re-sync.
    const isAction = force || Boolean(sync.updatedBy);

    // The video ended: the server clock keeps running, but never restart the video by ourselves
    if (state === ENDED && !isAction) return;

    const diff = Math.abs(player.getCurrentTime() - target);
    // The scan further down finds a local change within half a second. If the player has
    // moved a long way since that scan last took a reading, then the user is the one moving
    // it (YouTube gives no "user seeked" event, so a jump is the only evidence there is).
    // Do not undo it here - the scan reports it a moment later and the whole room follows.
    // Without this, a routine 15 second re-sync landing in that gap threw the seek away
    // before it was ever sent, which is why a seek reached the others only sometimes.
    const movedByUser = Math.abs(player.getCurrentTime() - lastTimeRef.current.time) > SEEK_JUMP_SECONDS;
    if (isAction) {
      // someone pressed play, pause or seek: follow exactly
      if (diff > 0.5) {
        ignoreEvents();
        debugSeek(player, target, force ? 'undo participant change' : `follow ${sync.updatedBy ? 'a button press' : 'server'}`);
        player.seekTo(target, true);
        lastTimeRef.current = { time: target, at: Date.now() };
      }
    } else if (
      playing &&
      state === PLAYING &&
      !movedByUser &&
      Date.now() > settleUntilRef.current &&
      // Behind the room: catch up quickly. Ahead of the room: only jump back if it is far off,
      // because a small lead is usually just the host buffering for a moment.
      (target - player.getCurrentTime() > MAX_DRIFT_SECONDS || player.getCurrentTime() - target > MAX_AHEAD_SECONDS)
    ) {
      // Small timing drift: fix it, then leave the player alone for a few seconds.
      // This is for EVERYONE, including the host and moderators. Those two used to be
      // skipped as "the reference", which works with one controller and breaks with
      // two: the host and a moderator each trusted only themselves and drifted apart
      // for good. The room clock is now the one reference for all of them.
      ignoreEvents();
      debugSeek(player, target, 'drift correction');
      player.seekTo(target, true);
      lastTimeRef.current = { time: target, at: Date.now() };
      settleUntilRef.current = Date.now() + 5000;
    } else if (!playing && state === PAUSED && diff > 1 && !movedByUser) {
      // both sides are paused, just make sure we are on the same frame
      ignoreEvents();
      debugSeek(player, target, 'paused position correction');
      player.seekTo(target, true);
      lastTimeRef.current = { time: target, at: Date.now() };
    }

    // finally, make sure play/pause matches the room
    if (playing) {
      if (state !== PLAYING && state !== BUFFERING) {
        ignoreEvents();
        player.playVideo();
      }
      checkAutoplay();
    } else if (state !== PAUSED) {
      ignoreEvents();
      player.pauseVideo();
    }

    // Mute and speed only act when the room's value CHANGES (see applyMute/applyRate).
    // force is passed on so undoing a participant's change still puts the room's value back.
    applyMute(player, sync, force);
    applyRate(player, sync, force);
    // Subtitles are shared room state, exactly like mute and speed: whoever changes
    // them, everybody else obeys. This used to run for participants only, so the host
    // and a moderator never followed each other's subtitle choice at all.
    if (confirmedRef.current && player.getOption) applyRoomCaptions(player, sync);
  }

  // The user did something in YouTube's player (play, pause, seek or another video)
  function userAction(action, payload = {}) {
    console.info(`[watch-party] you used the player: ${action}`, payload);
    // A play or a pause that came from this browser: hold off re-asserting the room's
    // state until the server has had time to answer (see playSentAtRef).
    if (action === 'play' || action === 'pause') playSentAtRef.current = Date.now();
    onActionRef.current(action, payload); // tell the server: hosts change the room, participants send a request
    const isController = roleRef.current === 'host' || roleRef.current === 'moderator';
    if (!isController) {
      // a participant cannot change the room: put the player back (the request was sent above)
      // clearing the loaded id forces applyState down its "different video" branch for change_video
      if (action === 'change_video') loadedVideoIdRef.current = null;
      applyState(syncRef.current, true); // force = undo my own local change
    }
  }

  // ---- create the YouTube player once ----
  useEffect(() => {
    const container = containerRef.current;
    let cancelled = false; // React StrictMode runs effects twice in development
    let player = null;

    loadYouTubeApi()
      .catch(() => {
        if (!cancelled) setProblem('Could not load the YouTube player. Check your internet connection or ad blocker, then refresh.');
      })
      .then((YT) => {
      if (cancelled || !YT) return; // effect was already cleaned up: do not build anything
      // YouTube replaces this inner div with its own iframe
      const mountPoint = document.createElement('div');
      container.appendChild(mountPoint);
      player = new YT.Player(mountPoint, {
        width: '100%',
        height: '100%',
        // controls: show YouTube's own bar, rel: no related videos at the end, playsinline: no forced fullscreen on phones
        playerVars: { controls: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            if (cancelled) return;
            playerRef.current = player; // from now on every other function can use the player
            setReady(true);
          },
          // 100: not found or private, 101/150: the owner does not allow embedding
          onError: (e) => {
            if (cancelled) return;
            setProblem(
              [100, 101, 150].includes(e.data)
                ? 'This video cannot be played here (it is private, removed, or the owner blocks embedding). Ask the host to pick another video.'
                : 'The video player had a problem. Try another video.'
            );
          },
          // the user pressed play or pause in YouTube's player
          onStateChange: (e) => {
            // our own change, not the user's: drop the event (this is the anti-loop guard)
            if (Date.now() < ignoreUntilRef.current) return;
            const wanted = e.data;
            if (wanted !== PLAYING && wanted !== PAUSED) return; // ignore buffering, ended, ...
            // The player changed play/pause and it was not us who did it. Claim the change
            // right now, not 400ms below when it is confirmed: the scan that keeps re-asserting
            // the room's play/pause reads this, and the room still shows the OLD state until
            // the server has been told. Without this the scan would see "the room says playing,
            // this player is paused" and put the play back before the pause was ever sent.
            playSentAtRef.current = Date.now();
            // Where the video was when this state change happened. YouTube also pauses
            // for a moment when the user PRESSES its seek bar, and that pause is not a
            // real pause: the drag itself is reported as a seek a moment later, so
            // sending the pause too would stop the whole room in the middle of a scrub.
            const timeAtPress = playerRef.current ? playerRef.current.getCurrentTime() || 0 : 0;
            // YouTube pauses for a moment while the user drags its seek bar.
            // Wait a little and only act if the state is still the same.
            setTimeout(() => {
              const p = playerRef.current;
              const sync = syncRef.current;
              if (!p || !sync || !sync.videoId) return;
              if (Date.now() < ignoreUntilRef.current) return; // we changed something in the meantime
              if (p.getPlayerState() !== wanted) return; // only a short flicker, not a real press
              // A real pause leaves the video where it is; a seek-bar drag moves it,
              // which is exactly what this comparison catches.
              if (wanted === PAUSED && Math.abs((p.getCurrentTime() || 0) - timeAtPress) > 0.5) return;
              const time = p.getCurrentTime() || 0;
              // only report a change that really differs from the room, so we do not echo
              if (wanted === PLAYING && sync.playState !== 'playing') userAction('play', { time });
              else if (wanted === PAUSED && sync.playState === 'playing') userAction('pause', { time });
            }, 400);
          },
        },
      });
    });

    // Cleanup: remove the player completely and empty the container. Without destroying it,
    // the old iframe would keep playing (and its timers/listeners would keep running).
    // The cancelled flag stops the async setup above from finishing after this ran
    // (StrictMode mounts, unmounts and mounts again, so a second player would be created otherwise).
    return () => {
      cancelled = true;
      if (player && typeof player.destroy === 'function') player.destroy();
      container.replaceChildren();
      playerRef.current = null;
      loadedVideoIdRef.current = null;
      confirmedRef.current = false;
      setReady(false);
    };
  }, []);

  // Browsers may block video that starts with sound before the user clicked.
  // Then we start it muted, and the next click anywhere turns the sound on.
  function checkAutoplay() {
    setTimeout(() => {
      const player = playerRef.current;
      if (!player || !player.getPlayerState || !wantPlayingRef.current) return;
      const state = player.getPlayerState();
      // Only when the video never started. Never touch an ended or paused video.
      if (state === UNSTARTED || state === CUED) {
        ignoreEvents();
        player.mute(); // a muted video is always allowed to start
        player.playVideo();
        autoMutedRef.current = true;
        setAutoMuted(true);
      }
    }, 1500); // give YouTube a moment to actually begin before deciding it was blocked
  }

  // After the browser forced us muted, the very next click anywhere means the user has
  // interacted, so sound is allowed again: restore the room's real mute setting.
  useEffect(() => {
    if (!autoMuted) return;
    function unmute() {
      autoMutedRef.current = false;
      setAutoMuted(false);
      // go back to the room's mute setting. Forced, because the browser muted us behind
      // our back: the room's value may not have changed, but the player no longer matches it.
      if (playerRef.current && syncRef.current) applyMute(playerRef.current, syncRef.current, true);
    }
    // { once: true } removes the listener after the first click by itself
    window.addEventListener('pointerdown', unmute, { once: true });
    return () => window.removeEventListener('pointerdown', unmute);
  }, [autoMuted]);

  // ---- follow the server ----
  // Runs on every new syncState: this is the one place that pushes the room's state into the player.
  useEffect(() => {
    if (ready) applyState(syncState);
  }, [syncState, ready]);

  // ---- host and moderator: every 2 seconds tell the server where the video really is ----
  // Only the reference players report their time; everyone else just follows the server.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      const sync = syncRef.current;
      const isCtrl = roleRef.current === 'host' || roleRef.current === 'moderator';
      if (!player || !isCtrl || !sync || sync.playState !== 'playing') return; // only while really playing
      if (Date.now() < ignoreUntilRef.current) return;
      // while a new video is still loading, its position means nothing: do not report it
      if (!confirmedRef.current) return;
      const state = player.getPlayerState();
      if (state !== PLAYING && state !== BUFFERING) return;
      onActionRef.current('heartbeat', { time: player.getCurrentTime() || 0 });
    }, 2000);
    return () => clearInterval(id); // stop the timer when the player goes away
  }, [ready]);

  // ---- every half second: did the user seek or open another video in YouTube's player? ----
  // YouTube gives no "user seeked" event, so we detect it by comparing the clock against
  // where the video should be, and by checking which video YouTube is really showing.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !player.getCurrentTime || !loadedVideoIdRef.current) return;

      const now = Date.now();
      const current = player.getCurrentTime() || 0;
      const state = player.getPlayerState();
      const last = lastTimeRef.current; // the previous reading
      lastTimeRef.current = { time: current, at: now }; // remember this reading for next time

      // while we are changing the player ourselves, only keep track of the time
      if (now < ignoreUntilRef.current) return;

      // another video (for example one picked at the end of the video)
      const data = player.getVideoData ? player.getVideoData() : null;

      // Right after loading, YouTube may still report the old video or position 0 for a while.
      // Do nothing until the new video is really in the player.
      if (!confirmedRef.current) {
        const showing = data && data.video_id === loadedVideoIdRef.current;
        if (showing && (state === PLAYING || state === PAUSED || state === CUED)) {
          confirmedRef.current = true; // now the player truly holds our video
          retriesRef.current = 0;
          setProblem('');
        } else if (
          showing &&                                    // our video is in the player...
          state === BUFFERING &&                        // ...but it is stuck loading
          syncRef.current && syncRef.current.playState === 'playing' &&
          now - playFixAtRef.current > 2000
        ) {
          // The room is playing and this player is holding the right video but has not started.
          // Everything below this point is skipped until the video is confirmed, so without this
          // the only recovery was the 8 second retry above - which reloads the whole video and
          // loses the position. Asking a loading player to play is harmless if it is already on
          // its way, and it is what rescues one that has genuinely stalled.
          playFixAtRef.current = now;
          console.info('[watch-party] room is playing but this video is still loading: asking it to play');
          player.playVideo();
        }
        return;
      }

      const isCtrl = roleRef.current === 'host' || roleRef.current === 'moderator';

      // 1. a genuinely different video is now in the player: report it.
      // This is checked before the seek below: picking another video also makes the
      // current time jump, and that is a change of video, not a seek in this one.
      if (data && data.video_id && data.video_id !== loadedVideoIdRef.current) {
        const videoId = data.video_id;
        // for a controller, remember it here too so applyState will not load it a second time
        if (isCtrl) loadedVideoIdRef.current = videoId;
        userAction('change_video', { videoId });
        return;
      }

      // 2. Did the user drag the seek bar? This comes next, before anything else in
      // this tick. YouTube gives no "user seeked" event, so the only evidence is the
      // jump found right here - and the checks further down are allowed to end the tick
      // early (a mute, a speed or a subtitle change they want to report). Because the
      // previous reading is replaced at the top of this function, an early return used
      // to swallow the jump for good: the seek was never sent, so the room stayed where
      // it was while the person who dragged saw their own video move. That is what made
      // a moderator's seek reach everybody sometimes and not at all other times.
      const expected = state === PLAYING ? last.time + (now - last.at) / 1000 : last.time;
      if (state !== UNSTARTED && Math.abs(current - expected) > SEEK_JUMP_SECONDS) {
        userAction('seek', { time: current });
        return;
      }

      // 3. host or moderator used YouTube's mute button: tell the room
      // the 2 second gap (muteSentAtRef) is the debounce, so it is sent only once
      if (isCtrl && !autoMutedRef.current && player.isMuted && syncRef.current && now - muteSentAtRef.current > 2000) {
        const mutedNow = player.isMuted();
        if (mutedNow !== Boolean(syncRef.current.muted)) {
          muteSentAtRef.current = now;
          userAction(mutedNow ? 'mute' : 'unmute');
          return;
        }
      }

      // 4. host or moderator changed the speed in YouTube's settings: tell the room
      if (isCtrl && player.getPlaybackRate && syncRef.current && now - rateSentAtRef.current > 2000) {
        const rateNow = player.getPlaybackRate();
        if (Math.abs(rateNow - (syncRef.current.rate || 1)) > 0.01) {
          rateSentAtRef.current = now;
          userAction('set_rate', { rate: rateNow });
          return;
        }
      }

      // 5. Subtitles. Everyone obeys the room's choice (applyState does that), so the
      // only thing left for a controller to do here is notice a CHANGE made in this
      // browser and send it on. The room's choice is compared against what we have
      // already obeyed, NOT against what the player shows: reporting "what the player
      // shows" is what made this fight - a player whose captions module was still
      // loading, or whose video has no such track, looked like a user who had switched
      // subtitles off, and it kept telling the room to switch them off for everybody.
      // Wait until the video has been loaded for a while: subtitles arrive late.
      if (isCtrl && player.getOption && syncRef.current && now - loadedAtRef.current > 6000) {
        const roomKey = captionsKey(syncRef.current.captions);
        if (roomKey !== appliedCaptionsRef.current) {
          // somebody changed the room's subtitles (or this is the first look at them):
          // obey, giving the captions module as many tries as it needs
          applyRoomCaptions(player, syncRef.current, 2000);
          captionPendingRef.current = null; // and stop judging the old choice
        } else {
          const here = readCaptions(player);
          const hereKey = captionsKey(here);
          if (hereKey !== roomKey) {
            // We already obeyed the room, so a difference now can only be a change made
            // in this browser. One exception: if the room asked for a track this video
            // does not have, the player will never be able to show it, and reporting
            // that as "subtitles off" would switch them off for everybody.
            const reportable = hereKey !== '' || hasCaptionTrack(player, syncRef.current.captions);
            // A debounce decides a change is real: YouTube reports caption changes in
            // several small steps, so require the same state for 1.5 seconds.
            const pending = captionPendingRef.current;
            if (!reportable) {
              captionPendingRef.current = null; // nothing we are allowed to report
            } else if (!pending || pending.key !== hereKey) {
              captionPendingRef.current = { key: hereKey, since: now }; // start waiting
            } else if (now - pending.since > 1500) {
              captionPendingRef.current = null;
              const track = here || { lang: null, kind: '' };
              console.info('[watch-party] sending your subtitle choice to the room:', track.lang, track.kind);
              userAction('set_captions', { lang: track.lang, kind: track.kind });
              return;
            }
          } else {
            captionPendingRef.current = null; // back in sync, nothing pending
          }
        }
      }

      // 6. Keep play/pause true OVER TIME, not only at the moment a sync arrived.
      // applyState() is the one other place that starts or stops this player, and it runs
      // only when a NEW sync_state arrives. It also leaves a BUFFERING player alone on
      // purpose, expecting it to start by itself. Put those together and a player that is
      // still loading when a play arrives - which is ordinary on a slow connection - can
      // settle into paused and never be asked again: the room says it is playing, this
      // video sits still, and nothing corrects it until somebody presses something. So
      // re-assert the room's state here as well, on a timer, where it cannot stay wrong.
      const room = syncRef.current;
      if (
        room && room.videoId &&
        now > ignoreUntilRef.current &&         // not while we are the ones driving the player
        now > settleUntilRef.current &&         // not straight after a drift correction
        now - playSentAtRef.current > 4000 &&   // not while a press made here is still travelling
        now - playFixAtRef.current > 2000       // and at most one correction every 2 seconds
      ) {
        const wantPlaying = room.playState === 'playing';
        // BUFFERING counts as "not playing yet". Asking a loading player to play is harmless
        // (YouTube ignores it until it has data) and it is the only thing that rescues a
        // player which stalled and would otherwise never start on its own.
        const notPlaying =
          state === PAUSED || state === CUED || state === UNSTARTED || state === BUFFERING;

        if (wantPlaying && notPlaying) {
          playFixAtRef.current = now;
          ignoreEvents();
          console.info('[watch-party] room is playing but this player is not: asking it to play');
          player.playVideo();
          return;
        }

        if (!wantPlaying && state === PLAYING) {
          playFixAtRef.current = now;
          ignoreEvents();
          console.info('[watch-party] room is paused but this player is not: asking it to pause');
          player.pauseVideo();
          return;
        }
      }
    }, 500);
    return () => clearInterval(id);
  }, [ready]);

  // ---- participants: keep subtitles the same as the room's (subtitles load late, so check often) ----
  // A participant cannot touch YouTube's own buttons (the video is covered), so this
  // interval is the whole story for them: it keeps trying until the player really
  // shows the room's choice, and then stops.
  useEffect(() => {
    if (!ready || isController) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      const sync = syncRef.current;
      if (player && sync && player.getOption && confirmedRef.current) applyRoomCaptions(player, sync);
    }, 3000);
    return () => clearInterval(id);
  }, [ready, isController]);

  // ---- participants cannot see YouTube's bar, so read the time for our own read-only bar ----
  useEffect(() => {
    if (!ready || isController) return;
    const id = setInterval(() => {
      const player = playerRef.current;
      if (!player || !player.getCurrentTime) return;
      setProgress({ current: player.getCurrentTime() || 0, duration: player.getDuration() || 0 });
    }, 500);
    return () => clearInterval(id);
  }, [ready, isController]);

  // ---- fullscreen and volume for participants (their video is covered, so YouTube's buttons are out of reach) ----
  useEffect(() => {
    // the browser fires this for anyone entering or leaving fullscreen, so we only believe it
    // when the element is OUR wrapper
    function onChange() {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // toggle fullscreen on the wrapper (not the iframe), so our overlay buttons stay visible
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapperRef.current.requestFullscreen();
  }

  // Participant buttons: each one sends a REQUEST that the host or a moderator must approve
  function askSkip(delta) {
    const player = playerRef.current;
    if (!player) return;
    // clamp between 0 and the video length, so a request can never ask for an impossible time
    let time = Math.max(0, (player.getCurrentTime() || 0) + delta);
    const length = player.getDuration();
    if (length > 0) time = Math.min(time, length);
    onAction('seek', { time });
  }

  // used only for the label of the participant request button
  const isPlaying = syncState?.playState === 'playing';
  const roomMuted = Boolean(syncState?.muted);

  return (
    <div>
    {/* the wrapper is the element we put into fullscreen, and the position anchor for the overlays */}
    <div
      ref={wrapperRef}
      className={`relative bg-black ${isFullscreen ? 'h-screen w-screen' : 'aspect-video w-full'}`}
    >
      {/* YouTube injects its iframe here; the [&_iframe] rules make it fill the box */}
      <div ref={containerRef} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full" />

      {/* Participants can only watch: an invisible layer stops clicks reaching YouTube's player */}
      {/* This is only a convenience: the server enforces the rule for real, so hiding the */}
      {/* controls cannot actually let a participant change the room. */}
      {!isController && hasVideo && (
        <div
          className="absolute inset-0 z-10 cursor-not-allowed"
          title="Only the host and moderators can control the video. Use the request buttons below."
        />
      )}

      {/* friendly message instead of an empty black box before a video is chosen */}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 p-4 text-center text-sm text-gray-700">
          No video yet. The host or a moderator can paste a YouTube link below.
        </div>
      )}

      {/* z-20 puts the error on top of everything, including the click-blocking layer */}
      {problem && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-200 p-4 text-center text-sm text-gray-800">
          {problem}
        </div>
      )}

      {/* hint shown after the browser forced us muted, until the user clicks */}
      {autoMuted && (
        <p className="absolute left-2 top-2 bg-black/70 px-2 py-1 text-xs text-white">
          Sound is off. Click anywhere to turn it on.
        </p>
      )}
    </div>

    {/* participant toolbar: gives them a read-only progress bar and request buttons */}
    {!isController && hasVideo && (
      <div className="border border-t-0 border-gray-300 bg-white px-3 py-2 text-sm">
        {/* own progress bar, because YouTube's is hidden under the click-blocking layer */}
        {progress.duration > 0 && (
          <div className="mb-3">
            <div className="h-1.5 w-full bg-gray-200">
              <div
                className="h-full bg-gray-700"
                style={{ width: `${Math.min(100, (progress.current / progress.duration) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-600">
              {formatTime(progress.current)} / {formatTime(progress.duration)}
              {' '}({formatTime(Math.max(0, progress.duration - progress.current))} left)
            </p>
          </div>
        )}
        <p className="mb-2 text-xs text-gray-600">
          You are watching only. These buttons send a request to the host or a moderator.
        </p>
        {/* every button here only sends a request; nothing changes until a controller approves */}
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-light px-3! py-1!" onClick={() => onAction(isPlaying ? 'pause' : 'play')}>
            Request {isPlaying ? 'pause' : 'play'}
          </button>
          <button className="btn-light px-3! py-1!" onClick={() => askSkip(-10)}>Request back 10s</button>
          <button className="btn-light px-3! py-1!" onClick={() => askSkip(10)}>Request forward 10s</button>
          <button className="btn-light px-3! py-1!" onClick={() => onAction(roomMuted ? 'unmute' : 'mute')}>
            Request {roomMuted ? 'unmute' : 'mute'}
          </button>
          {/* the dropdown shows the room's current speed and requests a new one */}
          <label className="flex items-center gap-1 text-xs text-gray-600">
            Request speed
            <select
              className="border border-gray-400 bg-white px-1 py-1 text-sm text-gray-900"
              value={syncState?.rate || 1}
              onChange={(e) => onAction('set_rate', { rate: Number(e.target.value) })}
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                <option key={r} value={r}>{r}x</option>
              ))}
            </select>
          </label>
          {/* ml-auto pushes the fullscreen button to the right end of the row */}
          <button className="btn-light ml-auto px-3! py-1!" onClick={toggleFullscreen}>Fullscreen</button>
        </div>
      </div>
    )}
    </div>
  );
}
