import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import { generateShortLivedToken } from '~/crypto/jwt';

interface DeleteRagFileParams {
  /** The user ID. Required for authentication. If not provided, the function returns false and logs an error. */
  userId: string;
  /** The file object. Must have `embedded` and `file_id` properties. */
  file: {
    file_id: string;
    embedded?: boolean;
    metadata?: { embeddedEntities?: string[] } | null;
  };
}

/**
 * The RAG API owns an agent's chunks by the agent (`entity_id`) and deletes them only when the
 * request names it; without it the API answers 404 and keeps them. One delete per namespace the
 * file was embedded under, or one without an entity when it names none.
 */
export function ragDeleteScopes(file: DeleteRagFileParams['file']): Array<string | undefined> {
  const entities = (file.metadata?.embeddedEntities ?? []).filter(
    (entity): entity is string => typeof entity === 'string' && entity.length > 0,
  );
  return entities.length > 0 ? [...new Set(entities)] : [undefined];
}

/**
 * Deletes embedded document(s) from the RAG API.
 * This is a shared utility function used by all file storage strategies
 * (S3, Azure, Firebase, Local) to delete RAG embeddings when a file is deleted.
 *
 * @param params - The parameters object.
 * @param params.userId - The user ID for authentication.
 * @param params.file - The file object. Must have `embedded` and `file_id` properties.
 * @returns Returns true if deletion was successful or skipped, false if there was an error.
 */
export async function deleteRagFile({ userId, file }: DeleteRagFileParams): Promise<boolean> {
  if (!file.embedded || !process.env.RAG_API_URL) {
    return true;
  }

  if (!userId) {
    logger.error('[deleteRagFile] No user ID provided');
    return false;
  }

  const jwtToken = generateShortLivedToken(userId);
  let ok = true;

  for (const entityId of ragDeleteScopes(file)) {
    try {
      await axios.delete(`${process.env.RAG_API_URL}/documents`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        ...(entityId ? { params: { entity_id: entityId } } : {}),
        data: [file.file_id],
      });
      logger.debug(`[deleteRagFile] Successfully deleted document ${file.file_id} from RAG API`);
    } catch (error) {
      const axiosError = error as { response?: { status?: number }; message?: string };
      if (axiosError.response?.status === 404) {
        logger.warn(
          `[deleteRagFile] Document ${file.file_id} not found in RAG API, may have been deleted already`,
        );
      } else {
        logger.error('[deleteRagFile] Error deleting document from RAG API:', axiosError.message);
        ok = false;
      }
    }
  }

  return ok;
}
