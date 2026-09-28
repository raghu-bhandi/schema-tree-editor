// Navigation tree for a documentation site. Schema is generated from these interfaces.

/** Fields every node has. `id` must be unique within a file. */
interface Base {
  /**
   * Stable id. Don't reuse it.
   * @pattern ^[a-z0-9-]+$
   */
  id: string;
  /**
   * @title Title
   * @minLength 1
   */
  name: string;
}

/**
 * @title Site
 * @treeIcon globe
 * @treeSubtitle version
 */
export interface SiteNode extends Base {
  type: "site";
  /** @title Base URL @format uri */
  baseUrl: string;
  /** @title Docs version */
  version: string;
  children: SectionNode[];
}

/**
 * @title Section
 * @treeIcon folder
 */
export interface SectionNode extends Base {
  type: "section";
  /** @title Start collapsed */
  collapsed?: boolean;
  children: (SectionNode | PageNode | LinkNode)[];
}

/**
 * @title Page
 * @treeIcon file
 * @treeSubtitle status
 */
export interface PageNode extends Base {
  type: "page";
  /** @title Source file */
  file: string;
  /** @title Status */
  status: "draft" | "review" | "published";
  /** @title Summary @format textarea */
  summary?: string;
}

/**
 * @title Link
 * @treeIcon link-external
 */
export interface LinkNode extends Base {
  type: "link";
  /** @title URL @format uri */
  url: string;
  /** @title Open in new tab */
  newTab?: boolean;
}
