import { seedDatabaseIfEmpty } from './seed';
import { seedGuidelinesIfEmpty } from './seedGuidelines';

export const seedStartupData = async (nodeEnv: string): Promise<void> => {
  if (nodeEnv !== 'development') return;

  await seedDatabaseIfEmpty();
  await seedGuidelinesIfEmpty();
};
