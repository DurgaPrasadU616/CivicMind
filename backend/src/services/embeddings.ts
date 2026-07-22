// backend/src/services/embeddings.ts

import { GoogleGenerativeAI } from '@google/generative-ai';

// Local deterministic unit vector generator for offline/sandboxed environments
const generateDeterministicEmbedding = (text: string): number[] => {
  const dimensions = 1536;
  const vector = new Array(dimensions).fill(0.0);

  // Normalize words
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    vector[0] = 1.0;
    return vector;
  }

  // Generate deterministic indices based on word hashes
  words.forEach((word) => {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    const index = Math.abs(hash) % dimensions;
    // Accumulate word frequency weight
    vector[index] += 1.0;
  });

  // Calculate Euclidean norm (magnitude)
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0.0));

  // Normalize vector to unit length (so dot product equals cosine similarity)
  return vector.map((val) => (magnitude > 0.0 ? val / magnitude : 0.0));
};

export const getEmbedding = async (text: string): Promise<number[]> => {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    // Return local deterministic hash embedding if offline/unconfigured
    return generateDeterministicEmbedding(text);
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await model.embedContent(text);
    
    if (result.embedding && result.embedding.values) {
      return result.embedding.values;
    }
    throw new Error('Malformed embedding response from Gemini API');
  } catch (error) {
    console.warn('⚠️ Gemini Embeddings API failed, reverting to local fallback:');
    return generateDeterministicEmbedding(text);
  }
};
