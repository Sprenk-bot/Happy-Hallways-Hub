import { describe, expect, test } from 'bun:test';
import { hubMovementRows, hubMovementRowsToCsv, hubVisitSummaryRowsToCsv } from './hub-reporting';
import type { HubVisit } from './types';

describe('Hub movement reporting', () => {
  test('keeps movement timestamps chronological and includes temporary trip events', () => {
    const visit: HubVisit = {
      id: 'visit-1',
      studentId: 'student-1',
      studentName: 'Avery Example',
      destinationLabel: 'Quiet Room',
      className: 'Support Group',
      periodName: 'Morning check-in',
      source: 'classroom-notification',
      leftClassAt: '2026-11-23T01:00:00.000Z',
      arrivedAtHubAt: '2026-11-23T01:05:00.000Z',
      temporaryTrips: [{
        id: 'trip-1',
        destinationLabel: 'Library',
        startedAt: '2026-11-23T01:10:00.000Z',
        startedBy: { staffId: 'ea-1', displayName: 'EA Example', role: 'ea' },
        returnedAt: '2026-11-23T01:20:00.000Z',
        returnedBy: { type: 'student-kiosk' },
      }],
    };

    expect(hubMovementRows([visit]).map((row) => row.event)).toEqual([
      'Left class',
      'Arrived at Hub',
      'Started temporary trip: Library',
      'Returned from temporary trip: Library',
    ]);
  });

  test('quotes CSV fields and never exports private concern note text', () => {
    const visit: HubVisit = {
      id: 'visit-2',
      studentId: 'student-2',
      studentName: 'Riley, Sample',
      destinationLabel: 'Quiet Room',
      source: 'direct-kiosk-arrival',
      hasConcern: true,
      arrivedAtHubAt: '2026-11-23T02:00:00.000Z',
      temporaryTrips: [],
    };
    const csv = hubMovementRowsToCsv(hubMovementRows([visit]));
    expect(csv).toContain('"Riley, Sample"');
    expect(csv).toContain('Yes');
    expect(csv).not.toContain('private concern note');
  });

  test('leaves the concern field blank when no concern was recorded', () => {
    const visit: HubVisit = {
      id: 'visit-3', studentId: 'student-3', studentName: 'Jordan Example',
      destinationLabel: 'Quiet Room', source: 'direct-kiosk-arrival',
      arrivedAtHubAt: '2026-11-23T03:00:00.000Z', temporaryTrips: [],
    };
    const csv = hubMovementRowsToCsv(hubMovementRows([visit]));
    expect(csv.split('\n')[1].split(',')[8]).toBe('');
  });

  test('exports visit timestamps, prompt answers, and blank optional notes in one row', () => {
    const visit: HubVisit = {
      id: 'visit-4', studentId: 'student-4', studentName: 'Casey Example', destinationLabel: 'Support room',
      source: 'classroom-notification', leftClassAt: '2026-11-23T03:00:00Z', arrivedAtHubAt: '2026-11-23T03:03:00Z',
      leftHubAt: '2026-11-23T03:12:00Z', arrivedBackAtClassAt: '2026-11-23T03:16:00Z', hasConcern: false,
      promptResponses: [{ promptId: 'q1', promptVersion: 1, destinationId: 'destination-4', stage: 'arrival', question: 'How are you?', responseType: 'written', required: false, answer: 'Okay', answeredAt: '2026-11-23T03:04:00Z' }],
      temporaryTrips: [],
    };
    const csv = hubVisitSummaryRowsToCsv([visit]);
    expect(csv).toContain('Left class at,Arrived at Hub,Left Hub,Returned to class');
    expect(csv).toContain('How are you?: Okay');
    expect(csv.split('\n')[1].split(',')[9]).toBe('');
  });
});
