import { pool } from './db';
import { clusterComplaint } from '../services/clustering';

export const seedDatabaseIfEmpty = async () => {
  if (!pool) return;
  try {
    const checkTable = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'complaint')");
    if (!checkTable.rows[0].exists) {
      console.warn('⚠️ complaint table does not exist. Skipping seed.');
      return;
    }

    const res = await pool.query('SELECT COUNT(*) FROM complaint');
    const count = parseInt(res.rows[0].count, 10);
    if (count > 0) {
      return; // Already populated
    }

    console.log('🌱 Database is empty. Seeding and clustering initial complaints...');

    // Get source IDs
    const sourceRes = await pool.query('SELECT id, name FROM source');
    const sources = sourceRes.rows.reduce((acc: any, row: any) => {
      acc[row.name] = row.id;
      return acc;
    }, {});

    const portalId = sources['citizen_portal'];
    if (!portalId) {
      console.error('❌ Cannot seed database: "citizen_portal" source record not found.');
      return;
    }

    const mockComplaints = [
      {
        text: 'Large crater-like pothole on Main Street near the central signal is causing bikers to fall.',
        category: 'infrastructure',
        latitude: 12.9716,
        longitude: 77.5946,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4958',
      },
      {
        text: 'Road surface is heavily chipped and broken on Main St, leading to dangerous skidding conditions.',
        category: 'infrastructure',
        latitude: 12.9725,
        longitude: 77.5952,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4959',
      },
      {
        text: 'Pavement caved in on Main Street, pedestrian lane completely blocked.',
        category: 'infrastructure',
        latitude: 12.9708,
        longitude: 77.5938,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4960',
      },
      {
        text: 'Huge heap of wet garbage dumped inside Central Park entrance, giving off an unbearable stench.',
        category: 'sanitation',
        latitude: 12.9842,
        longitude: 77.5891,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4961',
      },
      {
        text: 'Plastic waste and litter piling up near Central Park lake, harming birds.',
        category: 'sanitation',
        latitude: 12.9835,
        longitude: 77.5878,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4962',
      },
      {
        text: 'Main drinking water pipeline burst in Sector 4, clean drinking water is being wasted in large quantities.',
        category: 'utility',
        latitude: 12.9562,
        longitude: 77.6201,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4963',
      },
      {
        text: 'Water supply contaminated with muddy sediment in Sector 4 households.',
        category: 'utility',
        latitude: 12.9555,
        longitude: 77.6215,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4964',
      },
      {
        text: 'Extremely loud party speaker music played beyond 11 PM near Metro residency blocks.',
        category: 'noise',
        latitude: 12.9648,
        longitude: 77.5721,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4965',
      },
      {
        text: 'Streetlights are completely dead in the alley connecting 4th Cross Road. It gets pitch dark and unsafe for women.',
        category: 'safety',
        latitude: 12.9691,
        longitude: 77.6083,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4966',
      },
      {
        text: 'Stray cows sitting in the middle of double road causing traffic blocks and accidents.',
        category: 'other',
        latitude: 12.9810,
        longitude: 77.6320,
        idempotencyKey: 'c7c25bb3-2e02-4b2a-89a1-773df4fb4967',
      },
    ];

    for (const c of mockComplaints) {
      const insRes = await pool.query(
        `INSERT INTO complaint (source_id, text, category, latitude, longitude, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [portalId, c.text, c.category, c.latitude, c.longitude, c.idempotencyKey]
      );
      if (insRes.rows && insRes.rows.length > 0) {
        const id = insRes.rows[0].id;
        // Automatically cluster and score severity for E2E consistency
        await clusterComplaint(id);
      }
    }
    console.log('✅ Successfully seeded and clustered complaints database.');
  } catch (error) {
    console.error('❌ Error seeding complaints table:', error);
  }
};
