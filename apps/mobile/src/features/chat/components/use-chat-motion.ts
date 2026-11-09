import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Keyboard, type LayoutChangeEvent, type NativeScrollEvent } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useReducedMotion } from "@/shared/lib/motion";
import { chatContentIsVisible } from "../model/chat-layout";

/** The space under each row of the list. */
export const CHAT_ROW_GAP = 10;
/** The composer lays out at its open height. At rest it is shorter, and the chat rests against it. */
const COMPOSER_REST_SLACK = 18;
/** A message from search opens this far under the header. */
const FOCUS_GAP = 12;
/** On Android the chat takes the latest message this many frames after the last row has its size. */
const ANDROID_PLACE_FRAMES = 2;
/** The longest wait on Android before the chat takes the latest message, also without a measured row. */
const ANDROID_PLACE_TIMEOUT_MS = 250;
/** How long the list keeps the latest message in view after the chat has its rows and its latest page. */
const OPENING_FOLLOW_MS = 600;
/** The composer's field tweens its height for 120 ms. The list follows it for this long after the last layout. */
const COMPOSER_SETTLE_MS = 180;

type AnchorReadyInfo = { anchorKey?: string; anchorIndex?: number };

export function useChatMotion(
  header: number,
  keyboardOffset: number,
  ready: boolean,
  /** The list has rows. Rows that come into an empty list get a new first position. */
  hasRows: boolean,
  lastUserId: string | null,
  requiredInputId: string | null = null,
  /** The chat opens at a message from search: do not move to the latest message while it loads. */
  holdOpening = false,
  /** The chat shows the messages that the phone kept, and reads the latest page of the host. */
  catchingUp = false,
) {
  const listRef = useRef<LegendListRef>(null);
  const reducedMotion = useReducedMotion();
  const keyboardHeight = useSharedValue(0);
  // 0 while the keyboard is down, 1 while it is fully up, and every value
  // between during an interactive dismissal. The composer reads this to size
  // itself, so a swipe drives the shape change frame by frame.
  const keyboardProgress = useSharedValue(0);
  const keyboardDismissed = useSharedValue(false);
  const composerHeight = useSharedValue(0);
  const viewport = useSharedValue(0);
  const content = useSharedValue(0);
  // The list writes its scroll position here on the UI thread, so scrolling runs no JavaScript here.
  const scrollOffset = useSharedValue(0);
  const followLatest = useRef(true);
  const keyboardMoving = useSharedValue(false);
  // The list was at the latest message when the keyboard started to move.
  const keyboardFromLatest = useSharedValue(false);
  // The composer changes height while the keyboard moves or the draft wraps, and its inset changes with
  // it. The scroll that follows does not get all of that change, so the list stops short of the end.
  // This closes the difference. The list gets the new inset some frames later, so its scrollToEnd can
  // use the old inset. The end comes from the measurements here, which have the composer's height now.
  const measurements = useRef({ viewport: 0, content: 0, composer: 0 });
  const settleAtLatest = useCallback(
    (animated: boolean) => {
      if (!followLatest.current) return;
      const m = measurements.current;
      const end = m.content - m.viewport + m.composer + Math.max(0, keyboardHeight.get() - keyboardOffset);
      listRef.current?.getNativeScrollRef()?.scrollTo({ y: Math.max(0, end), animated: animated && !reducedMotion });
    },
    [keyboardHeight, keyboardOffset, reducedMotion],
  );
  // Track opening and interactive frames. Once dismissal starts, finish the
  // return independently so a missing completion cannot retain keyboard space.
  useKeyboardHandler(
    {
      onStart: (event) => {
        "worklet";
        keyboardMoving.set(true);
        keyboardFromLatest.set(
          chatContentIsVisible(
            content.get(),
            viewport.get(),
            scrollOffset.get(),
            composerHeight.get() + Math.max(0, keyboardHeight.get() - keyboardOffset),
          ),
        );
        if (event.height > 0) {
          cancelAnimation(keyboardHeight);
          cancelAnimation(keyboardProgress);
          keyboardDismissed.set(false);
        } else {
          // Complete the return from the destination event. An interrupted iOS
          // dismissal can omit its final frame; subsequent drag frames must not
          // cancel this animation and leave the composer above an absent keyboard.
          keyboardDismissed.set(true);
          const timing = {
            duration: Math.max(0, event.duration),
            easing: Easing.out(Easing.cubic),
            reduceMotion: ReduceMotion.System,
          };
          keyboardHeight.set(withTiming(0, timing));
          keyboardProgress.set(withTiming(0, timing));
        }
      },
      onMove: (event) => {
        "worklet";
        if (keyboardDismissed.get()) return;
        keyboardHeight.set(event.progress === 0 ? 0 : event.height);
        keyboardProgress.set(event.progress);
      },
      onInteractive: (event) => {
        "worklet";
        if (keyboardDismissed.get()) return;
        keyboardHeight.set(event.progress === 0 ? 0 : event.height);
        keyboardProgress.set(event.progress);
      },
      onEnd: (event) => {
        "worklet";
        keyboardMoving.set(false);
        if (event.height <= 0 || event.progress === 0) {
          keyboardDismissed.set(true);
          keyboardHeight.set(0);
          keyboardProgress.set(0);
        } else if (!keyboardDismissed.get()) {
          keyboardHeight.set(event.height);
          keyboardProgress.set(event.progress);
        }
        if (keyboardFromLatest.get()) {
          keyboardFromLatest.set(false);
          scheduleOnRN(settleAtLatest, true);
        }
      },
    },
    [
      keyboardHeight,
      keyboardProgress,
      keyboardDismissed,
      keyboardMoving,
      keyboardFromLatest,
      keyboardOffset,
      composerHeight,
      viewport,
      content,
      scrollOffset,
      settleAtLatest,
    ],
  );
  useEffect(() => {
    // A native picker or interrupted dismissal can omit the controller's final frame.
    const subscription = Keyboard.addListener("keyboardDidHide", () => {
      keyboardMoving.set(false);
      keyboardDismissed.set(true);
      keyboardHeight.set(0);
      keyboardProgress.set(0);
    });
    return () => subscription.remove();
  }, [keyboardHeight, keyboardProgress, keyboardDismissed, keyboardMoving]);
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, keyboardHeight.get() - keyboardOffset) }],
  }));
  const lowestOffset = useSharedValue(0);
  const scrolledUp = useSharedValue(false);
  const firstOffset = useSharedValue(0);
  const firstOpacity = useSharedValue(1);
  const responseOpacity = useSharedValue(1);
  const revealed = useSharedValue(false);
  const [atLatest, setAtLatest] = useState(false);
  const atLatestNow = useRef(false);
  // The opening position is not the user's choice. Until the user drags the
  // list, the whole chat counts as seen, wherever the list lands.
  const [userScrolled, setUserScrolled] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [responseVisible, setResponseVisible] = useState(true);
  const pending = useRef<{ baseline: string | null; first: boolean; fromLatest: boolean } | null>(null);
  const [keyboardLiftBehavior, setKeyboardLiftBehavior] = useState<"whenAtEnd" | "never">("whenAtEnd");
  // Counts the returns to the latest messages from a window around a searched message.
  const [latestGeneration, setLatestGeneration] = useState(0);
  const lastRequiredInputId = useRef(requiredInputId);
  const requiredInputFrame = useRef<number | null>(null);
  const sendScrollFrame = useRef<number | null>(null);
  const composerSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerSettleFrame = useRef<number | null>(null);
  // Whether the list had rows when it last finished its first position. Null until it does once.
  const [placedWithRows, setPlacedWithRows] = useState<boolean | null>(null);
  // Rows that come into an empty list get a new first position, so the list waits for it. An empty
  // list has no position to wait for, and Legend List calls `onReady` only after it lays out a row.
  const listPlaced = !hasRows || placedWithRows === true;
  const shown = useRef(false);
  // While the chat opens, the list keeps the latest message in view: older rows come above the
  // first rows and get their sizes, and the latest page can add messages after the kept ones.
  const [openingFollow, setOpeningFollow] = useState(!holdOpening);
  const heldOpening = useRef(holdOpening);
  const current = useRef({ lastUserId });
  current.current = { lastUserId };

  const finishFirstMessage = useCallback(() => setResponseVisible(true), []);
  const updateAtLatest = useCallback((visible: boolean) => {
    atLatestNow.current = visible;
    setAtLatest(visible);
  }, []);
  const reveal = useCallback(() => {
    if (shown.current) return;
    shown.current = true;
    revealed.set(true);
    setHistoryVisible(true);
  }, [revealed]);
  /** The list finished the first position of its rows. */
  const onListReady = useCallback((withRows: boolean) => setPlacedWithRows(withRows), []);

  // The list shows once it has its place at the latest message. A message from search shows it itself.
  useLayoutEffect(() => {
    // The hold stays recorded until the list shows: it can end while the history still loads.
    if (holdOpening) heldOpening.current = true;
    if (shown.current || !listPlaced || !ready || holdOpening) return;
    const held = heldOpening.current;
    heldOpening.current = false;
    // The message from search did not open the chat, and the list did not take the end while it waited.
    if (held) void (listRef.current?.scrollToEnd({ animated: false }) ?? Promise.resolve()).then(reveal, reveal);
    else reveal();
  }, [listPlaced, ready, holdOpening, reveal]);
  // Android moves the list to the latest message with a native scroll, and Legend List can wait for
  // seconds for that scroll to report before it calls `onReady`. Once the last row has its size,
  // the chat takes the end itself: this ends the wait, and the list calls `onReady`. iOS places the
  // list without a native scroll, so it keeps the wait.
  useEffect(() => {
    if (shown.current || !hasRows || placedWithRows === true || !ready || holdOpening) return;
    const started = Date.now();
    let measuredFrames = 0;
    let frame = requestAnimationFrame(function place() {
      const list = listRef.current;
      const state = list?.getState();
      const last = state ? state.data.length - 1 : -1;
      // The size of a row is unset until the list has measured it.
      if (state && last >= 0 && state.sizeAtIndex(last) > 0) measuredFrames += 1;
      if (list && (measuredFrames > ANDROID_PLACE_FRAMES || Date.now() - started >= ANDROID_PLACE_TIMEOUT_MS)) {
        // The list calls `onReady` when this ends its wait. The end of the scroll places the list
        // also if it had no wait left to end.
        void list.scrollToEnd({ animated: false }).then(() => setPlacedWithRows(true));
        return;
      }
      frame = requestAnimationFrame(place);
    });
    return () => cancelAnimationFrame(frame);
  }, [hasRows, placedWithRows, ready, holdOpening]);
  useEffect(() => {
    if (!openingFollow || !ready || catchingUp) return;
    const timer = setTimeout(() => setOpeningFollow(false), OPENING_FOLLOW_MS);
    return () => clearTimeout(timer);
  }, [openingFollow, ready, catchingUp]);
  useLayoutEffect(() => {
    if (requiredInputId !== lastRequiredInputId.current && requiredInputId && followLatest.current && shown.current) {
      // The question row renders in this commit; its size is known from the next frame.
      if (requiredInputFrame.current !== null) cancelAnimationFrame(requiredInputFrame.current);
      requiredInputFrame.current = requestAnimationFrame(() => {
        requiredInputFrame.current = null;
        if (followLatest.current) void listRef.current?.scrollToEnd({ animated: !reducedMotion });
      });
    }
    lastRequiredInputId.current = requiredInputId;
  }, [requiredInputId, reducedMotion]);
  useEffect(
    () => () => {
      if (requiredInputFrame.current !== null) cancelAnimationFrame(requiredInputFrame.current);
      if (sendScrollFrame.current !== null) cancelAnimationFrame(sendScrollFrame.current);
      if (composerSettleTimer.current !== null) clearTimeout(composerSettleTimer.current);
      if (composerSettleFrame.current !== null) cancelAnimationFrame(composerSettleFrame.current);
    },
    [],
  );

  const onViewportLayout = useCallback(
    (event: Pick<LayoutChangeEvent, "nativeEvent">) => {
      measurements.current.viewport = event.nativeEvent.layout.height;
      viewport.set(event.nativeEvent.layout.height);
    },
    [viewport],
  );
  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      measurements.current.content = height;
      content.set(height);
    },
    [content],
  );
  const onComposerLayout = useCallback(
    (event: Pick<LayoutChangeEvent, "nativeEvent">) => {
      const height = event.nativeEvent.layout.height - COMPOSER_REST_SLACK;
      // The keyboard's end settles a change that comes while the keyboard moves. The field height tweens
      // over several layouts: the first one says if the list was at the end, and the list then follows each
      // one with no animation. The end of an animated scroll would stop the list from following the latest.
      if (
        height !== measurements.current.composer &&
        !keyboardMoving.get() &&
        (atLatestNow.current || composerSettleTimer.current !== null)
      ) {
        if (composerSettleTimer.current !== null) clearTimeout(composerSettleTimer.current);
        composerSettleTimer.current = setTimeout(() => {
          composerSettleTimer.current = null;
          settleAtLatest(false);
        }, COMPOSER_SETTLE_MS);
        // The list's padding takes the new height in the next frame, and a scroll before that stops at the old end.
        if (composerSettleFrame.current !== null) cancelAnimationFrame(composerSettleFrame.current);
        composerSettleFrame.current = requestAnimationFrame(() => {
          composerSettleFrame.current = null;
          settleAtLatest(false);
        });
      }
      measurements.current.composer = height;
      composerHeight.set(height);
    },
    [composerHeight, keyboardMoving, settleAtLatest],
  );
  /**
   * The row of the sent message exists. The chat moves to the end, against the composer.
   */
  const onAnchorReady = useCallback(
    (info: AnchorReadyInfo) => {
      const send = pending.current;
      const list = listRef.current;
      if (!send || !list || info.anchorKey === undefined || info.anchorKey === send.baseline) return;
      pending.current = null;
      reveal();
      // From older messages the list jumps: a long animated scroll would render every row on the way.
      const animated = !send.first && send.fromLatest && !reducedMotion;
      if (sendScrollFrame.current !== null) cancelAnimationFrame(sendScrollFrame.current);
      if (animated) {
        sendScrollFrame.current = requestAnimationFrame(() => {
          sendScrollFrame.current = requestAnimationFrame(() => {
            sendScrollFrame.current = null;
            void listRef.current?.scrollToEnd({ animated: true });
          });
        });
      } else {
        sendScrollFrame.current = null;
        void list.scrollToEnd({ animated: false });
      }
      if (!send.first || info.anchorIndex === undefined) return;
      // The first message rests against the composer, so it only settles a little.
      firstOffset.set(14);
      firstOpacity.set(withTiming(1, { duration: 200, reduceMotion: ReduceMotion.System }));
      firstOffset.set(
        withSpring(0, { duration: 400, dampingRatio: 1, reduceMotion: ReduceMotion.System }, (finished) => {
          if (!finished) return;
          responseOpacity.set(withTiming(1, { duration: 350, reduceMotion: ReduceMotion.System }));
          scheduleOnRN(finishFirstMessage);
        }),
      );
    },
    [finishFirstMessage, firstOffset, firstOpacity, reducedMotion, responseOpacity, reveal],
  );

  useAnimatedReaction(
    () =>
      revealed.get() &&
      chatContentIsVisible(
        content.get(),
        viewport.get(),
        scrollOffset.get(),
        composerHeight.get() + Math.max(0, keyboardHeight.get() - keyboardOffset),
      ),
    (visible, previous) => {
      if (visible !== previous) scheduleOnRN(updateAtLatest, visible);
    },
  );
  useAnimatedReaction(
    () => scrollOffset.get(),
    (y) => {
      if (!revealed.get() || scrolledUp.get()) return;
      // A status-bar tap or an assistive scroll moves the list up without a drag.
      lowestOffset.set(Math.max(lowestOffset.get(), y));
      if (y >= lowestOffset.get() - 24) return;
      scrolledUp.set(true);
      scheduleOnRN(setUserScrolled, true);
    },
  );
  const historyStyle = useAnimatedStyle(() => ({
    opacity: withTiming(revealed.get() ? 1 : 0, { duration: 150, reduceMotion: ReduceMotion.System }),
  }));
  const firstMessageStyle = useAnimatedStyle(() => ({
    opacity: firstOpacity.get(),
    transform: [{ translateY: firstOffset.get() }],
  }));
  const responseStyle = useAnimatedStyle(() => ({ opacity: responseOpacity.get() }));

  const beginSend = useCallback(() => {
    // A sent message takes its own place in the list.
    setOpeningFollow(false);
    followLatest.current = true;
    setKeyboardLiftBehavior("whenAtEnd");
    const baseline = current.current.lastUserId;
    const first = baseline === null;
    pending.current = { baseline, first, fromLatest: atLatestNow.current };
    if (first) {
      firstOpacity.set(0);
      responseOpacity.set(0);
      setResponseVisible(false);
    }
  }, [firstOpacity, responseOpacity]);
  const cancelSend = useCallback(() => {
    pending.current = null;
    if (sendScrollFrame.current !== null) cancelAnimationFrame(sendScrollFrame.current);
    sendScrollFrame.current = null;
    cancelAnimation(firstOffset);
    firstOffset.set(0);
    firstOpacity.set(1);
    responseOpacity.set(1);
    setResponseVisible(true);
  }, [firstOffset, firstOpacity, responseOpacity]);
  /** The reader, not the chat, now chooses the position. */
  const leaveLatest = useCallback(() => {
    setUserScrolled(true);
    followLatest.current = false;
    setKeyboardLiftBehavior("never");
  }, []);
  const onScrollBeginDrag = useCallback(() => {
    // A drag is the reader's choice. A move of the list while rows get their sizes is not.
    setOpeningFollow(false);
    leaveLatest();
    reveal();
    cancelSend();
  }, [leaveLatest, reveal, cancelSend]);
  /** Opens the chat with row `index` under the header, instead of at the latest message. */
  const openAt = useCallback(
    (index: number): Promise<void> => {
      leaveLatest();
      const scrolled = listRef.current?.scrollToIndex({ index, viewOffset: header + FOCUS_GAP, animated: false });
      return (scrolled ?? Promise.resolve()).then(reveal, reveal);
    },
    [leaveLatest, header, reveal],
  );
  /** Positions the chat at the latest message again, after the latest page replaces a window around a searched message. */
  const returnToLatest = useCallback(() => {
    followLatest.current = true;
    setKeyboardLiftBehavior("whenAtEnd");
    setLatestGeneration((generation) => generation + 1);
  }, []);
  const onScrollEndDrag = useCallback(
    (event: { nativeEvent: Pick<NativeScrollEvent, "contentOffset"> }) => {
      // Only a user scroll can resume following. Keyboard dismissal can make the
      // reply visible without the user choosing to return to it.
      const m = measurements.current;
      followLatest.current = chatContentIsVisible(
        m.content,
        m.viewport,
        event.nativeEvent.contentOffset.y,
        m.composer + Math.max(0, keyboardHeight.get() - keyboardOffset),
      );
      setKeyboardLiftBehavior(followLatest.current ? "whenAtEnd" : "never");
    },
    [keyboardHeight, keyboardOffset],
  );
  const scrollToLatest = useCallback(() => {
    followLatest.current = true;
    setKeyboardLiftBehavior("whenAtEnd");
    void listRef.current?.scrollToEnd({ animated: !reducedMotion });
  }, [reducedMotion]);

  return useMemo(
    () => ({
      listRef,
      listPlaced,
      /** While a message from search opens the chat, the list does not take the latest message. */
      startsAtEnd: !holdOpening,
      atLatest,
      userScrolled,
      historyVisible,
      responseVisible,
      composerHeight,
      composerStyle,
      keyboardHeight,
      keyboardProgress,
      keyboardLiftBehavior,
      /**
       * The list keeps the latest message in view. A question waits for the reader at the end of the
       * chat while it grows, and an opening chat stays at the latest message until the reader drags.
       */
      followsEnd: (requiredInputId !== null && keyboardLiftBehavior === "whenAtEnd") || (openingFollow && !holdOpening),
      scrollOffset,
      historyStyle,
      firstMessageStyle,
      responseStyle,
      onListReady,
      onAnchorReady,
      onViewportLayout,
      onContentSizeChange,
      onComposerLayout,
      onScrollBeginDrag,
      onScrollEndDrag,
      beginSend,
      cancelSend,
      scrollToLatest,
      openAt,
      returnToLatest,
      latestGeneration,
    }),
    [
      listPlaced,
      holdOpening,
      atLatest,
      userScrolled,
      historyVisible,
      responseVisible,
      composerHeight,
      composerStyle,
      keyboardHeight,
      keyboardProgress,
      keyboardLiftBehavior,
      requiredInputId,
      openingFollow,
      scrollOffset,
      historyStyle,
      firstMessageStyle,
      responseStyle,
      onListReady,
      onAnchorReady,
      onViewportLayout,
      onContentSizeChange,
      onComposerLayout,
      onScrollBeginDrag,
      onScrollEndDrag,
      beginSend,
      cancelSend,
      scrollToLatest,
      openAt,
      returnToLatest,
      latestGeneration,
    ],
  );
}

export type ChatMotion = ReturnType<typeof useChatMotion>;
