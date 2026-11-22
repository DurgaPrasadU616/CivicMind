jest.mock('../src/config/seed', () => ({
  seedDatabaseIfEmpty: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/config/seedGuidelines', () => ({
  seedGuidelinesIfEmpty: jest.fn().mockResolvedValue(undefined),
}));

import { seedDatabaseIfEmpty } from '../src/config/seed';
import { seedGuidelinesIfEmpty } from '../src/config/seedGuidelines';
import { seedStartupData } from '../src/config/startupSeeds';

describe('startup sample data seeding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not seed complaints or guidelines in production', async () => {
    await seedStartupData('production');

    expect(seedDatabaseIfEmpty).not.toHaveBeenCalled();
    expect(seedGuidelinesIfEmpty).not.toHaveBeenCalled();
  });

  it('preserves sample data seeding in development', async () => {
    await seedStartupData('development');

    expect(seedDatabaseIfEmpty).toHaveBeenCalledTimes(1);
    expect(seedGuidelinesIfEmpty).toHaveBeenCalledTimes(1);
  });
});
