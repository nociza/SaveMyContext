/** Public embedding contract for the framework-independent web component. */
export class SMCWorkspace extends HTMLElement {
  token: string;
  load(): Promise<void>;
}
