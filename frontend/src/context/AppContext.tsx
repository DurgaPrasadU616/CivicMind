'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

// Definitions for the data models
export interface Complaint {
  id: string;
  text: string;
  category: 'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other';
  latitude: number | null;
  longitude: number | null;
  status: 'pending' | 'in_progress' | 'resolved';
  created_at: string;
  contactName?: string;
  contactEmail?: string;
  clusterId?: string;
  idempotencyKey: string;
}

export interface Cluster {
  id: string;
  title: string;
  category: 'infrastructure' | 'sanitation' | 'utility' | 'noise' | 'safety' | 'other';
  region: 'Downtown' | 'North' | 'South' | 'East' | 'West';
  severity: number; // 0-100
  complaintCount: number;
  status: 'pending' | 'in_progress' | 'resolved';
  recommendedAction: string;
  lastUpdated: string;
  complaints: string[]; // List of complaint IDs
  latitude: number;     // Representative coordinate for maps
  longitude: number;
}

type UserRole = 'citizen' | 'ngo' | 'govt' | 'admin';

interface AppContextType {
  userRole: UserRole;
  changeRole: (role: UserRole) => void;
  complaints: Complaint[];
  clusters: Cluster[];
  submitComplaint: (payload: Omit<Complaint, 'id' | 'status' | 'created_at'>) => Complaint;
  updateClusterStatus: (clusterId: string, status: 'pending' | 'in_progress' | 'resolved') => void;
  updateComplaintStatus: (complaintId: string, status: 'pending' | 'in_progress' | 'resolved') => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Initial Mock complaints
const initialComplaints: Complaint[] = [
  {
    id: 'CM-1001',
    text: 'Large crater-like pothole on Main Street near the central signal is causing bikers to fall.',
    category: 'infrastructure',
    latitude: 12.9716,
    longitude: 77.5946,
    status: 'pending',
    created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    contactName: 'Rahul Sharma',
    contactEmail: 'rahul@example.com',
    clusterId: 'CL-201',
    idempotencyKey: 'idemp-1001',
  },
  {
    id: 'CM-1002',
    text: 'Road surface is heavily chipped and broken on Main St, leading to dangerous skidding conditions.',
    category: 'infrastructure',
    latitude: 12.9725,
    longitude: 77.5952,
    status: 'pending',
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    contactName: 'Amit Verma',
    contactEmail: 'amit@example.com',
    clusterId: 'CL-201',
    idempotencyKey: 'idemp-1002',
  },
  {
    id: 'CM-1003',
    text: 'Pavement caved in on Main Street, pedestrian lane completely blocked.',
    category: 'infrastructure',
    latitude: 12.9708,
    longitude: 77.5938,
    status: 'pending',
    created_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12 hrs ago
    contactName: 'Sneha Roy',
    contactEmail: 'sneha@example.com',
    clusterId: 'CL-201',
    idempotencyKey: 'idemp-1003',
  },
  {
    id: 'CM-1004',
    text: 'Huge heap of wet garbage dumped inside Central Park entrance, giving off an unbearable stench.',
    category: 'sanitation',
    latitude: 12.9842,
    longitude: 77.5891,
    status: 'in_progress',
    created_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    contactName: 'David K.',
    contactEmail: 'david@example.com',
    clusterId: 'CL-202',
    idempotencyKey: 'idemp-1004',
  },
  {
    id: 'CM-1005',
    text: 'Plastic waste and litter piling up near Central Park lake, harming birds.',
    category: 'sanitation',
    latitude: 12.9835,
    longitude: 77.5878,
    status: 'in_progress',
    created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    contactName: 'Meera Das',
    contactEmail: 'meera@example.com',
    clusterId: 'CL-202',
    idempotencyKey: 'idemp-1005',
  },
  {
    id: 'CM-1006',
    text: 'Main drinking water pipeline burst in Sector 4, clean drinking water is being wasted in large quantities.',
    category: 'utility',
    latitude: 12.9562,
    longitude: 77.6201,
    status: 'resolved',
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    contactName: 'Joseph V.',
    contactEmail: 'joseph@example.com',
    clusterId: 'CL-203',
    idempotencyKey: 'idemp-1006',
  },
  {
    id: 'CM-1007',
    text: 'Water supply contaminated with muddy sediment in Sector 4 households.',
    category: 'utility',
    latitude: 12.9555,
    longitude: 77.6215,
    status: 'resolved',
    created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    contactName: 'Kiran Rao',
    contactEmail: 'kiran@example.com',
    clusterId: 'CL-203',
    idempotencyKey: 'idemp-1007',
  },
  {
    id: 'CM-1008',
    text: 'Extremely loud party speaker music played beyond 11 PM near Metro residency blocks.',
    category: 'noise',
    latitude: 12.9648,
    longitude: 77.5721,
    status: 'pending',
    created_at: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
    contactName: 'Nitin J.',
    contactEmail: 'nitin@example.com',
    clusterId: 'CL-204',
    idempotencyKey: 'idemp-1008',
  },
  {
    id: 'CM-1009',
    text: 'Streetlights are completely dead in the alley connecting 4th Cross Road. It gets pitch dark and unsafe for women.',
    category: 'safety',
    latitude: 12.9691,
    longitude: 77.6083,
    status: 'pending',
    created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: 'idemp-1009',
  },
  {
    id: 'CM-1010',
    text: 'Stray cows sitting in the middle of double road causing traffic blocks and accidents.',
    category: 'other',
    latitude: 12.9810,
    longitude: 77.6320,
    status: 'pending',
    created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: 'idemp-1010',
  },
];

// Initial Mock Clusters
const initialClusters: Cluster[] = [
  {
    id: 'CL-201',
    title: 'Main Street Road Damage',
    category: 'infrastructure',
    region: 'Downtown',
    severity: 78,
    complaintCount: 3,
    status: 'pending',
    recommendedAction: 'Deploy road repair crew for emergency asphalt patching on Main St.',
    lastUpdated: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    complaints: ['CM-1001', 'CM-1002', 'CM-1003'],
    latitude: 12.9716,
    longitude: 77.5946,
  },
  {
    id: 'CL-202',
    title: 'Central Park Dumping & Litter',
    category: 'sanitation',
    region: 'North',
    severity: 62,
    complaintCount: 2,
    status: 'in_progress',
    recommendedAction: 'Redirect municipal waste truck to clear Central Park entry dump site. Clean lake boundary.',
    lastUpdated: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    complaints: ['CM-1004', 'CM-1005'],
    latitude: 12.9838,
    longitude: 77.5885,
  },
  {
    id: 'CL-203',
    title: 'Sector 4 Water Line Rupture',
    category: 'utility',
    region: 'East',
    severity: 85,
    complaintCount: 2,
    status: 'resolved',
    recommendedAction: 'Close main water valves, repair primary supply pipeline and inspect filter beds.',
    lastUpdated: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    complaints: ['CM-1006', 'CM-1007'],
    latitude: 12.9558,
    longitude: 77.6208,
  },
  {
    id: 'CL-204',
    title: 'Metro Residency Noise Disturbances',
    category: 'noise',
    region: 'West',
    severity: 45,
    complaintCount: 1,
    status: 'pending',
    recommendedAction: 'Issue formal warning letter to residents and request local patrol enforcement.',
    lastUpdated: new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString(),
    complaints: ['CM-1008'],
    latitude: 12.9648,
    longitude: 77.5721,
  },
];

export const AppContextProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [userRole, setUserRole] = useState<UserRole>('citizen');
  const [complaints, setComplaints] = useState<Complaint[]>(initialComplaints);
  const [clusters, setClusters] = useState<Cluster[]>(initialClusters);

  // Sync role to localStorage to persist refresh
  useEffect(() => {
    const savedRole = localStorage.getItem('civicmind_role');
    if (savedRole) {
      setUserRole(savedRole as UserRole);
    }
  }, []);

  const changeRole = (role: UserRole) => {
    setUserRole(role);
    localStorage.setItem('civicmind_role', role);
  };

  // Process submission of new complaints
  const submitComplaint = (payload: Omit<Complaint, 'id' | 'status' | 'created_at'>): Complaint => {
    const newId = `CM-${1000 + complaints.length + 1}`;
    const newComplaint: Complaint = {
      ...payload,
      id: newId,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    // 1. Add to complaints array
    const updatedComplaints = [newComplaint, ...complaints];
    setComplaints(updatedComplaints);

    // 2. Perform Mock Clustering logic
    // Determine the Region based on coordinates (Mock region lookup)
    const lat = payload.latitude || 12.9716;
    const lng = payload.longitude || 77.5946;
    let region: Cluster['region'] = 'Downtown';
    
    if (lat > 12.975) {
      region = 'North';
    } else if (lat < 12.96) {
      region = 'South';
    } else if (lng > 77.61) {
      region = 'East';
    } else if (lng < 77.58) {
      region = 'West';
    }

    // Try to find a matching cluster of the same Category & Region
    const matchingClusterIndex = clusters.findIndex(
      (c) => c.category === payload.category && c.region === region && c.status !== 'resolved'
    );

    if (matchingClusterIndex !== -1) {
      // Add to existing cluster
      const updatedClusters = [...clusters];
      const cluster = updatedClusters[matchingClusterIndex];
      cluster.complaints = [...cluster.complaints, newId];
      cluster.complaintCount += 1;
      cluster.severity = Math.min(100, cluster.severity + 5); // incremental severity per duplicate complaint
      cluster.lastUpdated = new Date().toISOString();
      
      // Update complaint reference
      newComplaint.clusterId = cluster.id;
      setClusters(updatedClusters);
    } else {
      // Create a new cluster for it (70% probability)
      const shouldCluster = Math.random() > 0.3;
      if (shouldCluster) {
        const newClusterId = `CL-${200 + clusters.length + 1}`;
        const cleanCategory = payload.category.charAt(0).toUpperCase() + payload.category.slice(1);
        const newCluster: Cluster = {
          id: newClusterId,
          title: `${cleanCategory} Issue in ${region}`,
          category: payload.category,
          region,
          severity: Math.floor(Math.random() * 40) + 30, // 30 - 70 range
          complaintCount: 1,
          status: 'pending',
          recommendedAction: `Inspect the reported ${payload.category} issue in ${region} and draft action plan.`,
          lastUpdated: new Date().toISOString(),
          complaints: [newId],
          latitude: lat,
          longitude: lng,
        };
        newComplaint.clusterId = newClusterId;
        setClusters([...clusters, newCluster]);
      }
    }

    return newComplaint;
  };

  // Modify cluster status and automatically updates status of all complaints within it
  const updateClusterStatus = (clusterId: string, status: 'pending' | 'in_progress' | 'resolved') => {
    setClusters(
      clusters.map((cluster) => {
        if (cluster.id === clusterId) {
          return { ...cluster, status, lastUpdated: new Date().toISOString() };
        }
        return cluster;
      })
    );

    // Sync all complaints belonging to this cluster
    setComplaints(
      complaints.map((c) => {
        if (c.clusterId === clusterId) {
          return { ...c, status };
        }
        return c;
      })
    );
  };

  // Modify individual complaint status
  const updateComplaintStatus = (complaintId: string, status: 'pending' | 'in_progress' | 'resolved') => {
    setComplaints(
      complaints.map((c) => {
        if (c.id === complaintId) {
          return { ...c, status };
        }
        return c;
      })
    );
  };

  return (
    <AppContext.Provider
      value={{
        userRole,
        changeRole,
        complaints,
        clusters,
        submitComplaint,
        updateClusterStatus,
        updateComplaintStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppContextProvider');
  }
  return context;
};
