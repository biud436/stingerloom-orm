import { Injectable } from "@nestjs/common";
import {
  SearchRepository,
  IssueSearchHit,
  CustomFieldHit,
} from "./repositories/search.repository.abstract";

export type { IssueSearchHit, CustomFieldHit };

/**
 * Thin facade that delegates to the dialect-specific repository chosen
 * in `SearchModule` based on `EntityManager.getDriver()`. The branching
 * lives in the module wiring, not here.
 */
@Injectable()
export class SearchService {
  constructor(private readonly repo: SearchRepository) {}

  fullTextIssues(
    queryText: string,
    projectId?: number,
    limit = 20,
  ): Promise<IssueSearchHit[]> {
    return this.repo.fullTextIssues(queryText, projectId, limit);
  }

  byCustomField(
    projectId: number,
    key: string,
    value: string,
    limit = 50,
  ): Promise<CustomFieldHit[]> {
    return this.repo.byCustomField(projectId, key, value, limit);
  }
}
