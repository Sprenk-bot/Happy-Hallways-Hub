import type { HubVisit } from './types';

export type RatingSummary = {
  question: string;
  stage: 'arrival' | 'departure';
  scaleMax: number;
  promptVersion: number;
  count: number;
  mean: number;
  median: number;
  distribution: number[];
};

export type StudentHubAnalytics = {
  visitCount: number;
  checkInCount: number;
  averageVisitMinutes: number | null;
  ratings: RatingSummary[];
  dailyVisits: { day: string; visits: number }[];
};

/** Summarises recorded events only. It does not infer causes or clinical meaning. */
export function hubStudentAnalytics(visits: HubVisit[], studentId: string, since?: string): StudentHubAnalytics {
  const selected = visits.filter((visit) => visit.studentId === studentId && (!since || (visit.leftClassAt ?? visit.arrivedAtHubAt ?? '') >= since));
  const responses = selected.flatMap((visit) => visit.promptResponses ?? []);
  const buckets = new Map<string, { question: string; stage: 'arrival' | 'departure'; scaleMax: number; promptVersion: number; values: number[] }>();
  for (const response of responses) {
    if (response.responseType !== 'rating' || typeof response.answer !== 'number' || !response.scaleMax) continue;
    const key = JSON.stringify([response.question, response.stage, response.scaleMax, response.promptVersion]);
    const bucket = buckets.get(key) ?? { question: response.question, stage: response.stage, scaleMax: response.scaleMax, promptVersion: response.promptVersion, values: [] };
    bucket.values.push(response.answer);
    buckets.set(key, bucket);
  }
  const ratings = [...buckets.values()].map((bucket) => {
    const sorted = [...bucket.values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const distribution = Array.from({ length: bucket.scaleMax }, (_, i) => sorted.filter((value) => value === i + 1).length);
    return { ...bucket, count: sorted.length, mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, distribution };
  });
  const durations = selected.flatMap((visit) => {
    const start = visit.arrivedAtHubAt;
    const end = visit.leftHubAt;
    if (!start || !end) return [];
    const minutes = (Date.parse(end) - Date.parse(start)) / 60_000;
    return Number.isFinite(minutes) && minutes >= 0 ? [minutes] : [];
  });
  const byDay = new Map<string, number>();
  for (const visit of selected) {
    const stamp = visit.leftClassAt ?? visit.arrivedAtHubAt;
    if (!stamp) continue;
    const day = stamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return {
    visitCount: selected.length,
    checkInCount: responses.length,
    averageVisitMinutes: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    ratings,
    dailyVisits: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, visits]) => ({ day, visits })),
  };
}
