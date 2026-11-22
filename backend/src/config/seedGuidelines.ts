import { pool } from './db';
import { getEmbedding } from '../services/embeddings';
import logger from '../utils/logger';

export const seedGuidelinesIfEmpty = async () => {
  if (!pool) return;
  try {
    const checkTable = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'guideline_document')");
    if (!checkTable.rows[0].exists) {
      logger.warn('⚠️ guideline_document table does not exist. Skipping seed.');
      return;
    }

    const res = await pool.query('SELECT COUNT(*) FROM guideline_document');
    const count = parseInt(res.rows[0].count, 10);
    if (count > 0) {
      return; // Already populated
    }

    logger.info('🌱 Database is empty of guidelines. Seeding municipal SOPs...');

    const guidelines = [
      {
        title: 'Emergency Water Tanker Protocol',
        category: 'utility',
        content: 'Water supply disruptions affecting more than 500 households should trigger emergency tanker deployment within 6 hours per municipal water crisis protocol W-01.',
        source: 'Municipal SOP v2'
      },
      {
        title: 'Contaminated Water Response',
        category: 'utility',
        content: 'Reports of muddy or contaminated water in residential areas require immediate health advisories and testing within 2 hours. Do not use for drinking or cooking.',
        source: 'Health Dept Guidelines'
      },
      {
        title: 'Major Pothole Repair',
        category: 'infrastructure',
        content: 'Large craters on main arterial roads must be barricaded within 4 hours and patched within 24 hours to prevent accidents.',
        source: 'Roads & Traffic SOP'
      },
      {
        title: 'Pavement Cave-in Action Plan',
        category: 'infrastructure',
        content: 'Pavement cave-ins blocking pedestrian lanes require immediate cordoning and structural assessment within 12 hours.',
        source: 'Public Works Handbook'
      },
      {
        title: 'Hazardous Waste Dump',
        category: 'sanitation',
        content: 'Huge heaps of garbage inside public parks must be cleared within 8 hours. If the waste emits foul stench, it requires specialized bio-hazard removal.',
        source: 'Sanitation Dept Protocol S-03'
      },
      {
        title: 'Waterbody Protection',
        category: 'sanitation',
        content: 'Plastic waste piling near lakes harming wildlife must be escalated to the Environmental Protection division for a cleanup drive within 48 hours.',
        source: 'Environmental SOP'
      },
      {
        title: 'Late Night Noise Control',
        category: 'noise',
        content: 'Loud music played beyond 11 PM near residential blocks warrants immediate police dispatch to enforce the noise abatement ordinance.',
        source: 'City Police Guidelines'
      },
      {
        title: 'Streetlight Outages',
        category: 'safety',
        content: 'Completely dead streetlights in connecting alleys creating safety hazards for women must be prioritized for repair by the electrical board within 24 hours.',
        source: 'Women Safety Initiative SOP'
      },
      {
        title: 'Stray Animal Traffic Block',
        category: 'other',
        content: 'Stray animals causing traffic blocks on main double roads must be safely relocated by the animal control unit within 2 hours.',
        source: 'Traffic & Animal Control Protocol'
      }
    ];

    for (const g of guidelines) {
      const embedding = await getEmbedding(g.content);
      const embeddingStr = `[${embedding.join(',')}]`;
      await pool.query(
        `INSERT INTO guideline_document (title, category, content, embedding, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [g.title, g.category, g.content, embeddingStr, g.source]
      );
    }
    
    logger.info('✅ Successfully seeded guideline documents.');
  } catch (error) {
    logger.error('❌ Error seeding guideline_document table:', error);
  }
};
