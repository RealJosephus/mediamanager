import { bindJsonModel } from '../http/json-model-binding.js';

const triggerTypes = ['DailyTrigger', 'WeeklyTrigger', 'IntervalTrigger', 'StartupTrigger'];
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const enumRule = (clrType, values, nullable = false) => ({
  type: 'enum', clrType, nullable, values: Object.fromEntries(values.map((name, index) => [name, index]))
});
const nullableLong = { type: 'long', clrType: 'System.Nullable`1[System.Int64]', nullable: true };
const reference = 'MediaBrowser.Model.Tasks.TaskTriggerInfo';
const schema = {
  definitions: {
    [reference]: {
      defaults: { Type: 'DailyTrigger' },
      fields: {
        Type: enumRule('MediaBrowser.Model.Tasks.TaskTriggerInfoType', triggerTypes),
        TimeOfDayTicks: nullableLong,
        IntervalTicks: nullableLong,
        DayOfWeek: enumRule('System.Nullable`1[System.DayOfWeek]', dayNames, true),
        MaxRuntimeTicks: nullableLong
      },
      required: []
    }
  }
};
const root = {
  type: 'array',
  clrType: 'MediaBrowser.Model.Tasks.TaskTriggerInfo[]',
  item: { type: 'object', clrType: reference, reference, nullable: true }
};

export function bindTaskTriggerInfos(value, source) {
  return bindJsonModel(value, { schema, root, source });
}
