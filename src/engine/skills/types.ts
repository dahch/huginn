export interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  filePath: string;
  builtin?: boolean;
}
