import java.io.*;
import java.net.*;
import java.nio.file.*;

/**
 * A command-line client for Javad, for measuring and for trying it outside the tab
 * (tabcomputer's own client is src/commands/java.ts):
 *
 *   java -cp javad.jar JavadClient STATE_DIR OP CWD args...
 *
 * OP is Javad's op letter (c, m, e, r, p, q). Prints the time the request took on stderr.
 */
public class JavadClient {
  public static void main(String[] a) throws Exception {
    int port = Integer.parseInt(new String(Files.readAllBytes(Paths.get(a[0], "port"))).trim());
    long t0 = System.nanoTime();
    try (Socket s = new Socket(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), port)) {
      DataOutputStream out = new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));
      out.writeByte(a[1].charAt(0)); out.writeUTF(a[2]); out.writeUTF("");
      out.writeInt(a.length - 3);
      for (int i = 3; i < a.length; i++) out.writeUTF(a[i]);
      if (a[1].charAt(0) == 'r') out.writeInt(0);
      out.flush();
      DataInputStream in = new DataInputStream(new BufferedInputStream(s.getInputStream()));
      for (;;) {
        int k = in.readUnsignedByte(), n = in.readInt();
        if (k == 0) { System.err.println("[exit " + n + " in " + (System.nanoTime() - t0) / 1000000 + " ms]"); System.exit(n); }
        byte[] b = new byte[n]; in.readFully(b);
        (k == 1 ? System.out : System.err).write(b); System.out.flush(); System.err.flush();
      }
    }
  }
}
