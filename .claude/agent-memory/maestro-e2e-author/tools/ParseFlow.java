import java.nio.file.*;
import java.util.*;
import maestro.orchestra.yaml.YamlCommandReader;
import maestro.orchestra.MaestroCommand;

public class ParseFlow {
  static int scanRepeat(Object o, int depth) { return 0; }
  public static void main(String[] args) {
    int bad = 0;
    for (String a : args) {
      Path p = Paths.get(a);
      try {
        List<MaestroCommand> cmds = YamlCommandReader.INSTANCE.readCommands(p);
        String dump = cmds.toString();
        int repeats = dump.split("RepeatCommand", -1).length - 1;
        System.out.println("OK   " + p.getFileName() + "  commands=" + cmds.size()
            + "  RepeatCommand nodes=" + repeats);
        // print each RepeatCommand's times/condition
        int i = 0;
        for (String seg : dump.split("RepeatCommand\\(")) {
          if (i++ == 0) continue;
          int end = Math.min(seg.length(), 160);
          System.out.println("       repeat[" + (i-1) + "]: " + seg.substring(0, end).replaceAll("\\s+", " "));
        }
      } catch (Throwable t) {
        bad++;
        System.out.println("FAIL " + p.getFileName() + "  -> " + t.getClass().getSimpleName()
            + ": " + String.valueOf(t.getMessage()).split("\n")[0]);
      }
    }
    System.exit(bad == 0 ? 0 : 1);
  }
}
