import type { MessageKey, Translate } from '../../i18n';
import { Icon } from '../../app/icon';

export type DataTask = 'backup' | 'restore' | 'delete';
const tasks: readonly { id: DataTask; label: MessageKey }[] = [
  { id: 'backup', label: 'backup.title' }, { id: 'restore', label: 'restore.title' }, { id: 'delete', label: 'delete.title' },
];
const taskRowId = (task: DataTask) => `data-row-${task}`;

/** The Data and privacy rows. Each opens its tool in a task view inside Settings. */
export function DataHub({ t, disabled, onOpen }: { t: Translate; disabled: boolean; onOpen: (task: DataTask) => void }) {
  return <ul className="settings-card data-hub">
    {tasks.map(task => <li key={task.id}>
      <button type="button" id={taskRowId(task.id)} className={task.id === 'delete' ? 'data-row data-row-danger' : 'data-row'} disabled={disabled}
        onClick={() => onOpen(task.id)}><span>{t(task.label)}</span><Icon name="chevron" className="data-row-chevron" /></button>
    </li>)}
  </ul>;
}
