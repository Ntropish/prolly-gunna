import "./App.css";

import { WasmProllyTree } from "prolly-wasm";

import { useAppStore } from "./useAppStore";

import { Button } from "./components/ui/button";
import { produce } from "immer";

const encoder = new TextEncoder();
const toU8 = (s: string): Uint8Array => encoder.encode(s);

const toString = (u8: Uint8Array): string => {
  const decoder = new TextDecoder();
  return decoder.decode(u8);
};

function App() {
  const handleCreateTree = async () => {
    const tree = new WasmProllyTree();
    useAppStore.setState((state) => ({
      trees: produce(state.trees, (draft) => {
        draft.push(tree);
      }),
    }));
  };

  return (
    <>
      <div className="App">
        <h1>Prolly Web</h1>
        <Button onClick={handleCreateTree}>Create Tree</Button>
        <ul>
          {useAppStore((state) => state.trees).map((tree, index) => (
            <li key={index}>Tree {index + 1}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default App;
