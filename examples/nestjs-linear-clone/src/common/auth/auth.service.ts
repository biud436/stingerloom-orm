import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Inject,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import * as bcrypt from "bcryptjs";
import { User } from "../../modules/users/user.entity";
import { JwtPayload } from "./auth.types";

const BCRYPT_ROUNDS = 10;

export interface IssuedToken {
  accessToken: string;
  expiresIn: number;
  user: { id: number; email: string; name: string };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: BaseRepository<User>,
    private readonly jwt: JwtService,
  ) {}

  @Transactional()
  async register(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<IssuedToken> {
    const existing = await this.users.findOne({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException(`User with email ${input.email} already exists`);
    }

    const user = new User();
    user.email = input.email;
    user.name = input.name;
    user.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const saved = await this.users.save(user);

    return this.signFor(saved);
  }

  async login(input: { email: string; password: string }): Promise<IssuedToken> {
    const user = await this.users.findOne({ where: { email: input.email } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return this.signFor(user);
  }

  /**
   * Dev-only escape hatch: mint a token for any user id without a password.
   * Gated by `NODE_ENV !== "production"` *and* a deploy-time env flag, so
   * production builds can never call it. Used by tests and the seed CLI.
   */
  async issueDevToken(userId: number): Promise<IssuedToken> {
    if (process.env.NODE_ENV === "production") {
      throw new UnauthorizedException("Dev tokens disabled in production");
    }
    if (process.env.AUTH_ALLOW_DEV_TOKEN !== "true") {
      throw new UnauthorizedException(
        "Dev tokens disabled — set AUTH_ALLOW_DEV_TOKEN=true to enable",
      );
    }
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException(`User ${userId} not found`);
    return this.signFor(user);
  }

  private async signFor(user: User): Promise<IssuedToken> {
    const payload: JwtPayload = { sub: user.id };
    const accessToken = await this.jwt.signAsync(payload);
    const decoded = this.jwt.decode(accessToken) as JwtPayload | null;
    const expiresIn =
      decoded?.exp && decoded?.iat ? decoded.exp - decoded.iat : 0;
    return {
      accessToken,
      expiresIn,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
}
