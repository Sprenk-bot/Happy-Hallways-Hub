import { describe, expect, test } from 'bun:test';
import { hubStudentAnalytics } from './hub-analytics';
import type { HubVisit } from './types';

const visit = (id: string, answer: number, start: string): HubVisit => ({
  id, studentId: 'fictional-student', studentName: 'Avery Example', destinationLabel: 'Quiet Room',
  source: 'classroom-notification', temporaryTrips: [], arrivedAtHubAt: start,
  leftHubAt: new Date(Date.parse(start) + 20 * 60_000).toISOString(),
  promptResponses: [{ promptId: 'rating', promptVersion: 2, destinationId: 'quiet', stage: 'arrival', question: 'How settled?', responseType: 'rating', required: true, scaleMax: 5, answer, answeredAt: start }],
});

describe('hub student analytics', () => {
  test('reports sample sizes, rating distribution, dates and known durations', () => {
    const result = hubStudentAnalytics([visit('one', 2, '2026-11-01T09:00:00Z'), visit('two', 4, '2026-11-02T09:00:00Z')], 'fictional-student');
    expect(result.visitCount).toBe(2);
    expect(result.checkInCount).toBe(2);
    expect(result.averageVisitMinutes).toBe(20);
    expect(result.ratings[0]).toMatchObject({ count: 2, mean: 3, median: 3, distribution: [0, 1, 0, 1, 0], promptVersion: 2 });
    expect(result.dailyVisits).toHaveLength(2);
  });

  test('keeps different prompt versions separate and excludes other students', () => {
    const changed = { ...visit('three', 5, '2026-11-03T09:00:00Z'), promptResponses: [{ ...visit('three', 5, '2026-11-03T09:00:00Z').promptResponses![0], promptVersion: 3 }] };
    expect(hubStudentAnalytics([visit('one', 2, '2026-11-01T09:00:00Z'), changed], 'fictional-student').ratings).toHaveLength(2);
    expect(hubStudentAnalytics([visit('one', 2, '2026-11-01T09:00:00Z')], 'other').visitCount).toBe(0);
  });
});
