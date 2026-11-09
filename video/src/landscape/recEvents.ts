/** Recorded screen-capture metadata and cursor interpolation helpers. */
import aiEvents from '../../public/rec/ai.events.json';
import downloadEvents from '../../public/rec/download.events.json';
import homeEvents from '../../public/rec/home.events.json';
import logsEvents from '../../public/rec/logs.events.json';
import versionsEvents from '../../public/rec/versions.events.json';

export type RecEvent = {
  t: number;
  kind: 'move' | 'click' | 'type';
  x: number;
  y: number;
  text?: string;
};

export type RecordingName = 'home' | 'versions' | 'download' | 'logs' | 'ai';

export type Recording = {
  src: string;
  /** 1600x1000 CSS px viewport. */
  width: number;
  height: number;
  fps: number;
  duration: number;
  events: RecEvent[];
};

export const RECORDINGS: Record<RecordingName, Recording> = {
  home: {
    src: 'rec/home.mp4',
    width: 1600,
    height: 1000,
    fps: 30,
    duration: 7.8,
    events: homeEvents as RecEvent[],
  },
  versions: {
    src: 'rec/versions.mp4',
    width: 1600,
    height: 1000,
    fps: 30,
    duration: 8.97,
    events: versionsEvents as RecEvent[],
  },
  download: {
    src: 'rec/download.mp4',
    width: 1600,
    height: 1000,
    fps: 30,
    duration: 11.47,
    events: downloadEvents as RecEvent[],
  },
  logs: {
    src: 'rec/logs.mp4',
    width: 1600,
    height: 1000,
    fps: 30,
    duration: 7.17,
    events: logsEvents as RecEvent[],
  },
  ai: {
    src: 'rec/ai.mp4',
    width: 1600,
    height: 1000,
    fps: 30,
    duration: 11.87,
    events: aiEvents as RecEvent[],
  },
};

const pointEvents = (events: RecEvent[]) =>
  events.filter(
    (event) =>
      (event.kind === 'move' || event.kind === 'click') &&
      typeof event.x === 'number' &&
      typeof event.y === 'number',
  );

/** Linear interpolation between recorded mouse positions, clamped at both ends. */
export const cursorAt = (
  events: RecEvent[],
  time: number,
): {x: number; y: number; visible: boolean} => {
  const points = pointEvents(events);
  if (points.length === 0) return {x: 800, y: 500, visible: false};

  if (time <= points[0].t) {
    return {x: points[0].x, y: points[0].y, visible: time > 0};
  }
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const next = points[i];
    if (time <= next.t) {
      const p = (time - prev.t) / Math.max(0.001, next.t - prev.t);
      return {
        x: prev.x + (next.x - prev.x) * p,
        y: prev.y + (next.y - prev.y) * p,
        visible: true,
      };
    }
  }
  const last = points[points.length - 1];
  return {x: last.x, y: last.y, visible: true};
};

/** Clicks whose timestamps fall inside [start, end]. */
export const clicksInRange = (
  events: RecEvent[],
  start: number,
  end: number,
): RecEvent[] =>
  events.filter(
    (event) =>
      event.kind === 'click' && event.t >= start && event.t <= end,
  );

export const firstClickTime = (
  events: RecEvent[],
  fallback: number,
): number => {
  const click = events.find((event) => event.kind === 'click');
  return click ? click.t : fallback;
};
