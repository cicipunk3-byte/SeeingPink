import type { CodingLanguage } from '@/lib/thinkpinkBridge';

export type LearnLessonKind = 'lesson' | 'bridge';

export interface LearnLesson {
  id: string;
  title: string;
  eyebrow: string;
  description: string;
  language: CodingLanguage;
  kind: LearnLessonKind;
  targetLanguage?: CodingLanguage;
  concepts: string[];
  starterCode: string;
  note: string;
}

export interface LearnToCodeState {
  completedLessonIds: string[];
  drafts: Record<string, string>;
}

export const JAVA_LESSONS: LearnLesson[] = [
  {
    id: 'java-first-class',
    title: 'Your first class',
    eyebrow: 'Java 01',
    description: 'Give a small Java program a name, an entry point, and a message.',
    language: 'java',
    kind: 'lesson',
    concepts: ['class', 'main method', 'System.out.println'],
    starterCode: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, ThinkPink");
    }
}`,
    note: 'Java starts inside a class. The main method is where this first program begins.',
  },
  {
    id: 'java-values',
    title: 'Names and values',
    eyebrow: 'Java 02',
    description: 'Store a name and a number, then place both into a sentence.',
    language: 'java',
    kind: 'lesson',
    concepts: ['String', 'int', 'variables'],
    starterCode: `public class Main {
    public static void main(String[] args) {
        String name = "Mina";
        int practiceMinutes = 12;
        System.out.println(name + " practiced for " + practiceMinutes + " minutes.");
    }
}`,
    note: 'A variable gives a value a useful name. Java asks you to say what kind of value each variable holds.',
  },
  {
    id: 'java-decisions',
    title: 'Make a decision',
    eyebrow: 'Java 03',
    description: 'Let a program choose what to say when a condition is true.',
    language: 'java',
    kind: 'lesson',
    concepts: ['if', 'boolean expressions', 'comparison'],
    starterCode: `public class Main {
    public static void main(String[] args) {
        int minutes = 12;
        if (minutes >= 10) {
            System.out.println("A thoughtful start.");
        }
    }
}`,
    note: 'An if statement lets your program respond to a fact. Read the condition as a sentence before you change it.',
  },
  {
    id: 'java-loops',
    title: 'Repeat with a loop',
    eyebrow: 'Java 04',
    description: 'Use a loop to repeat a small action without copying the line.',
    language: 'java',
    kind: 'lesson',
    concepts: ['for loop', 'counter', 'repetition'],
    starterCode: `public class Main {
    public static void main(String[] args) {
        for (int step = 1; step <= 3; step++) {
            System.out.println("Practice step " + step);
        }
    }
}`,
    note: 'A loop has a start, a condition, and a change. Those three pieces keep repetition deliberate.',
  },
  {
    id: 'java-methods',
    title: 'Name a small action',
    eyebrow: 'Java 05',
    description: 'Move one idea into a method that you can call by name.',
    language: 'java',
    kind: 'lesson',
    concepts: ['methods', 'void', 'calling code'],
    starterCode: `public class Main {
    static void welcome() {
        System.out.println("Welcome back to practice.");
    }

    public static void main(String[] args) {
        welcome();
    }
}`,
    note: 'Methods make a program easier to read by giving one focused action a name.',
  },
];

export const PYTHON_LESSONS: LearnLesson[] = [
  {
    id: 'python-first-script',
    title: 'Your first script',
    eyebrow: 'Python 01',
    description: 'Write a first line of Python and ask it to introduce itself.',
    language: 'python',
    kind: 'lesson',
    concepts: ['print', 'strings', 'indentation'],
    starterCode: `def main():
    print("Hello, ThinkPink")


if __name__ == "__main__":
    main()`,
    note: 'Python uses indentation to show structure. In this example, the indented line belongs to main.',
  },
  {
    id: 'python-values',
    title: 'Names and values',
    eyebrow: 'Python 02',
    description: 'Keep a name and a practice time in variables, then use them together.',
    language: 'python',
    kind: 'lesson',
    concepts: ['variables', 'strings', 'integers'],
    starterCode: `def main():
    name = "Mina"
    practice_minutes = 12
    print(f"{name} practiced for {practice_minutes} minutes.")


if __name__ == "__main__":
    main()`,
    note: 'Python can infer a value type for you. Clear names still make your thinking easier to follow.',
  },
  {
    id: 'python-decisions',
    title: 'Make a decision',
    eyebrow: 'Python 03',
    description: 'Use a condition to choose whether a message belongs in the output.',
    language: 'python',
    kind: 'lesson',
    concepts: ['if', 'conditions', 'comparison'],
    starterCode: `def main():
    minutes = 12
    if minutes >= 10:
        print("A thoughtful start.")


if __name__ == "__main__":
    main()`,
    note: 'The colon starts an indented block. The indentation tells Python which lines belong to the decision.',
  },
  {
    id: 'python-loops',
    title: 'Repeat with a loop',
    eyebrow: 'Python 04',
    description: 'Repeat an action over a short range of practice steps.',
    language: 'python',
    kind: 'lesson',
    concepts: ['for loop', 'range', 'repetition'],
    starterCode: `def main():
    for step in range(1, 4):
        print(f"Practice step {step}")


if __name__ == "__main__":
    main()`,
    note: 'range gives the loop a small sequence of numbers. Read the first and last values carefully.',
  },
  {
    id: 'python-functions',
    title: 'Name a small action',
    eyebrow: 'Python 05',
    description: 'Put one idea in a function and call it from the main flow.',
    language: 'python',
    kind: 'lesson',
    concepts: ['def', 'functions', 'calling code'],
    starterCode: `def welcome():
    print("Welcome back to practice.")


def main():
    welcome()


if __name__ == "__main__":
    main()`,
    note: 'Functions are named pieces of work. A good function does one understandable thing.',
  },
];

export const BRIDGE_LESSONS: LearnLesson[] = [
  {
    id: 'bridge-java-to-python',
    title: 'Java to Python',
    eyebrow: 'Bridge lesson',
    description: 'Compare the same small idea in Java and Python, then notice what each language makes explicit.',
    language: 'java',
    targetLanguage: 'python',
    kind: 'bridge',
    concepts: ['syntax', 'printing', 'language choices'],
    starterCode: `public class Main {
    public static void main(String[] args) {
        String learner = "Mina";
        System.out.println("Hello, " + learner);
    }
}`,
    note: 'Translate the greeting to Python. Keep the idea the same while the punctuation and structure change.',
  },
  {
    id: 'bridge-python-to-java',
    title: 'Python to Java',
    eyebrow: 'Bridge lesson',
    description: 'Bring a short Python function across to Java and see why Java uses more ceremony.',
    language: 'python',
    targetLanguage: 'java',
    kind: 'bridge',
    concepts: ['functions and methods', 'types', 'structure'],
    starterCode: `def welcome(name):
    return "Hello, " + name


def main():
    print(welcome("Mina"))


if __name__ == "__main__":
    main()`,
    note: 'Translate this function to a Java method. Keep the return value and the call easy to spot.',
  },
];

export const DEFAULT_LEARN_STATE: LearnToCodeState = {
  completedLessonIds: [],
  drafts: {},
};

export function getTrackLessons(language: CodingLanguage) {
  return language === 'java' ? JAVA_LESSONS : PYTHON_LESSONS;
}

export function getAllLearnLessons() {
  return [...JAVA_LESSONS, ...PYTHON_LESSONS, ...BRIDGE_LESSONS];
}