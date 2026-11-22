import { pool } from '../config/db';
import logger from '../utils/logger';

export const assignCluster = async (clusterId: number, category: string, region: string) => {
  if (!pool) return;

  try {
    const dept = category.charAt(0).toUpperCase() + category.slice(1) + ' Department';

    // In a real app, query officials based on workload, region, availability, and skills.
    // Here we'll just pick a random official from the database, or create a fallback.
    const officialsRes = await pool.query(`SELECT id, name FROM "user" WHERE role IN ('govt', 'admin')`);
    
    let assignedOfficerId = null;
    let assignedOfficerName = 'Pending Assignment';

    if (officialsRes.rows.length > 0) {
      // Pick randomly or logic-based
      const randomOfficer = officialsRes.rows[Math.floor(Math.random() * officialsRes.rows.length)];
      assignedOfficerId = randomOfficer.id;
      assignedOfficerName = randomOfficer.name;
    }

    await pool.query(
      `UPDATE cluster SET assigned_department = $1, assigned_officer_id = $2 WHERE id = $3`,
      [dept, assignedOfficerId, clusterId]
    );

    logger.info(`[ASSIGNMENT] Assigned Cluster ${clusterId} to ${dept} (Officer: ${assignedOfficerName})`);
  } catch (error) {
    logger.error(`[ASSIGNMENT] Failed to assign Cluster ${clusterId}:`, error);
  }
};
