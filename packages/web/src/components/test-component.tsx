import { useEffect } from "react";
import { createCoframe } from "@/utils/coframe";
import type { ByteBuffer } from "flatbuffers";

// Import the generated class AND the plain object type
import { User, UserT } from "@/generated/app/data/user";
import { Profile, ProfileT } from "@/generated/app/data/profile";

// The UserT type is the plain object we'll work with.
export type UserType = UserT;
export type ProfileType = ProfileT; // Also export nested types

async function test() {
  const usersTable = createCoframe<UserType>({
    // Provide the function to get an accessor.
    getRootAs: (bb: ByteBuffer) => User.getRootAsUser(bb),

    // Provide the primary key field name.
    primaryKey: "id",
  });

  // The developer only ever works with the plain object type.
  const userToInsert = new UserT(
    "user-789",
    "Donald Knuth",
    87,
    new ProfileT("...", "..."),
    ["algorithms", "computer science"]
  );

  await usersTable.put(userToInsert);

  const retrievedUser = await usersTable.get("user-789");

  // retrievedUser is correctly and safely typed as the plain User object.
  console.log(retrievedUser?.name);
}

export const TestComponent = () => {
  useEffect(() => {
    test();
  }, []);

  return <div>TestComponent</div>;
};
