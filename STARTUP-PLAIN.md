# ThinkPink in plain words: a startup guide for people new to local models

Status: DRAFT (Ziggy, Sep 28) for the fresh public repo and the
/thinkpink page. Written for someone who has never installed a local
model. Sources verified in the lab's own local-model guide; every
claim here traces to that receipted list.

---

## First, the science, in one minute

An AI model is a big file full of numbers. When you "run" it, your
computer reads that file and predicts, number by number, what text
should come next. Nothing magical and nothing hidden: it is a file,
and it runs on a processor.

Most AI you have used runs this file in a company's data center. You
type, the words travel to them, their machine thinks, the answer
travels back. A **local model** flips that: the file downloads to
your computer, and the thinking happens where you sit. Your words
never leave the building.

### Why that matters

**Your records stay yours.** A local model has no server to leak, no
account to breach, and no company to read along. What the assistant
knows, it knows because a file on your disk says so.

**It keeps working when the internet does not.** No login, no
subscription, no service outage between you and your own notes.

**The footprint lands where you can see it.** Training and hosting
giant models in data centers takes a measurable toll: training GPT-3
directly evaporated an estimated 700,000 liters of clean freshwater,
and AI's water withdrawal is projected at 4.2 to 6.6 billion cubic
meters in 2027 (Li et al., Making AI Less "Thirsty", arXiv
2304.03271). Hosting general-purpose models costs far more energy per
use than small focused ones; generality is paid for on every request
(Luccioni, Jernite, Strubell, Power Hungry Processing, ACM FAccT 2024,
arXiv 2311.16863). The energy cost of AI is old news, named in 2019
when the field was first made to count it (Strubell, Ganesh,
McCallum, ACL 2019, arXiv 1906.02243), and researchers expect
inference, not training, to dominate AI's electricity use as these
tools spread (MIT News, January 2025). A small model on a machine you
already own is the honest version of that math.

## Setup, five steps, one cup of coffee

1. **Install Ollama.** Go to [ollama.com](https://ollama.com),
   download the installer for your Mac, run it. Ollama is the program
   that keeps model files and runs them for you.
2. **Get a small model.** Open a terminal and type
   `ollama pull gemma3:4b`, then press enter. It downloads a few
   gigabytes once. This is the model the lab treats as its floor:
   small enough to run on an ordinary laptop.
3. **Get ThinkPink.** Download it from the project's public
   repository (link in the flyer above) and follow the install steps
   in its README. Unsigned beta build: the first launch needs one
   Terminal step, spelled out there.
4. **Open ThinkPink.** It finds Ollama on its own. When you see the
   local-model indicator, you are connected to the model on your
   machine.
5. **Talk to it.** Everything you type stays on your computer. The
   assistant's memory lives in files you can open and read.

## What it cannot do (read this part too)

- A 4-billion-parameter model is not a giant hosted one. It is
  smaller, slower to learn new things, and it will sometimes be
  wrong. Treat its output as a first draft from an eager intern, not
  a verdict.
- ThinkPink is beta software. It was built to be tested in the open,
  and it says so on the tin.
- The governance gate records decisions and keeps receipts. It is a
  discipline, not a conscience: a person still has to read them.

## Sources

- Li, Yang, Islam, Ren (2023, rev. 2025), Making AI Less "Thirsty",
  Communications of the ACM. arXiv 2304.03271
- Luccioni, Jernite, Strubell (2024), Power Hungry Processing: Watts
  Driving the Cost of AI Deployment?, ACM FAccT 2024. arXiv 2311.16863
- Strubell, Ganesh, McCallum (2019), Energy and Policy Considerations
  for Deep Learning in NLP, ACL 2019. arXiv 1906.02243
- MIT News (2025), Explained: Generative AI's environmental impact.
- Ollama, the installer used in this guide. ollama.com

---

License note for the fresh repo: this guide is part of the ThinkPink
packaging layer (CC BY-NC-SA 4.0). The cited papers remain the
property of their authors.
