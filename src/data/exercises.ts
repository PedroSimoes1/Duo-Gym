/** Name/equipment shortcuts only. These are not prescribed routines or benchmark changes. */
export interface CommonExercise {
  id: string;
  exercise: string;
  equipment: string;
  group: 'Upper body' | 'Lower body' | 'Core';
  aliases?: string;
}

export const commonExercises: readonly CommonExercise[] = [
  {
    id: 'bench-barbell',
    exercise: 'Bench press',
    equipment: 'Barbell · flat',
    group: 'Upper body',
  },
  {
    id: 'squat-barbell',
    exercise: 'Squat',
    equipment: 'Barbell · back',
    group: 'Lower body',
    aliases: 'squats back squat',
  },
  {
    id: 'deadlift-barbell',
    exercise: 'Deadlift',
    equipment: 'Barbell · conventional',
    group: 'Lower body',
  },
  {
    id: 'row-dumbbell',
    exercise: 'Dumbbell row',
    equipment: 'Dumbbell',
    group: 'Upper body',
    aliases: 'rows back',
  },
  {
    id: 'lat-pulldown',
    exercise: 'Lat pulldown',
    equipment: 'Cable · wide grip',
    group: 'Upper body',
    aliases: 'back pull down',
  },
  { id: 'leg-press', exercise: 'Leg press', equipment: 'Machine · seated', group: 'Lower body' },
  {
    id: 'shoulder-press',
    exercise: 'Shoulder press',
    equipment: 'Dumbbells · seated',
    group: 'Upper body',
    aliases: 'overhead press shoulders',
  },
  {
    id: 'biceps-curl',
    exercise: 'Biceps curl',
    equipment: 'Dumbbells · standing',
    group: 'Upper body',
    aliases: 'bicep curls arms',
  },
  {
    id: 'bench-dumbbell',
    exercise: 'Bench press',
    equipment: 'Dumbbells · flat',
    group: 'Upper body',
  },
  {
    id: 'incline-press',
    exercise: 'Incline bench press',
    equipment: 'Dumbbells · incline',
    group: 'Upper body',
    aliases: 'chest',
  },
  {
    id: 'goblet-squat',
    exercise: 'Goblet squat',
    equipment: 'Dumbbell',
    group: 'Lower body',
    aliases: 'squats',
  },
  {
    id: 'romanian-deadlift',
    exercise: 'Romanian deadlift',
    equipment: 'Barbell',
    group: 'Lower body',
    aliases: 'rdl hamstrings',
  },
  {
    id: 'lunge',
    exercise: 'Lunge',
    equipment: 'Dumbbells · walking',
    group: 'Lower body',
    aliases: 'lunges',
  },
  {
    id: 'leg-curl',
    exercise: 'Leg curl',
    equipment: 'Machine · seated',
    group: 'Lower body',
    aliases: 'hamstring curl',
  },
  {
    id: 'leg-extension',
    exercise: 'Leg extension',
    equipment: 'Machine · seated',
    group: 'Lower body',
    aliases: 'quads',
  },
  {
    id: 'calf-raise',
    exercise: 'Calf raise',
    equipment: 'Machine · standing',
    group: 'Lower body',
    aliases: 'calves',
  },
  {
    id: 'cable-row',
    exercise: 'Seated row',
    equipment: 'Cable · neutral grip',
    group: 'Upper body',
    aliases: 'back rows',
  },
  {
    id: 'push-up',
    exercise: 'Push-up',
    equipment: 'Bodyweight · floor',
    group: 'Upper body',
    aliases: 'pushup push up chest',
  },
  {
    id: 'pull-up',
    exercise: 'Pull-up',
    equipment: 'Bodyweight · overhand grip',
    group: 'Upper body',
    aliases: 'pullup pull up back',
  },
  {
    id: 'triceps-pushdown',
    exercise: 'Triceps pushdown',
    equipment: 'Cable · rope',
    group: 'Upper body',
    aliases: 'tricep arms',
  },
  {
    id: 'lateral-raise',
    exercise: 'Lateral raise',
    equipment: 'Dumbbells · standing',
    group: 'Upper body',
    aliases: 'shoulders',
  },
  {
    id: 'crunch',
    exercise: 'Crunch',
    equipment: 'Bodyweight · floor',
    group: 'Core',
    aliases: 'abs crunches',
  },
  {
    id: 'cable-crunch',
    exercise: 'Cable crunch',
    equipment: 'Cable · kneeling',
    group: 'Core',
    aliases: 'abs',
  },
  {
    id: 'leg-raise',
    exercise: 'Leg raise',
    equipment: 'Bodyweight · hanging',
    group: 'Core',
    aliases: 'abs leg raises',
  },
];
